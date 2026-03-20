import { resolve as resolvePath } from 'node:path';
import type { AgentBackend, AgentRequest, AgentEvent, AgentEventBase, EventBus } from '@ccbuddy/core';
import { RateLimiter } from './session/rate-limiter.js';
import { PriorityQueue } from './session/priority-queue.js';
import { SessionManager } from './session/session-manager.js';
import type { Session } from './session/session-manager.js';
import type { QueuePriority } from './session/priority-queue.js';
import { DirectoryLock } from './session/directory-lock.js';

export interface AgentServiceOptions {
  backend: AgentBackend;
  eventBus?: EventBus;
  maxConcurrent: number;
  rateLimits: Record<string, number>;
  queueMaxDepth: number;
  queueTimeoutSeconds: number;
  sessionTimeoutMinutes: number;
  sessionCleanupHours: number;
}

interface QueuedRequest {
  request: AgentRequest;
  resolve: (value: void) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class AgentService {
  private backend: AgentBackend;
  private readonly eventBus?: EventBus;
  private readonly rateLimiter: RateLimiter;
  private readonly queue: PriorityQueue<QueuedRequest>;
  private readonly sessionManager: SessionManager;
  private readonly maxConcurrent: number;
  private readonly queueTimeoutSeconds: number;
  private activeConcurrent = 0;
  private readonly directoryLock = new DirectoryLock();
  private readonly directoryQueue = new Map<string, Array<{
    resolve: () => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>>();

  constructor(options: AgentServiceOptions) {
    this.backend = options.backend;
    this.eventBus = options.eventBus;
    this.maxConcurrent = options.maxConcurrent;
    this.queueTimeoutSeconds = options.queueTimeoutSeconds;
    this.rateLimiter = new RateLimiter(options.rateLimits);
    this.queue = new PriorityQueue<QueuedRequest>(options.queueMaxDepth);
    this.sessionManager = new SessionManager({
      timeoutMinutes: options.sessionTimeoutMinutes,
      cleanupHours: options.sessionCleanupHours,
    });
  }

  setBackend(backend: AgentBackend): void {
    this.backend = backend;
  }

  async *handleRequest(request: AgentRequest): AsyncGenerator<AgentEvent> {
    const base: AgentEventBase = {
      sessionId: request.sessionId,
      userId: request.userId,
      channelId: request.channelId,
      platform: request.platform,
    };

    // Check rate limit
    if (!this.rateLimiter.tryAcquire(request.userId, request.permissionLevel)) {
      yield { ...base, type: 'error', error: 'rate limit exceeded' };
      return;
    }

    // Directory lock — wait if another session is using the same directory
    if (request.workingDirectory) {
      const lockResult = this.directoryLock.acquire(
        request.workingDirectory, request.sessionId, request.userId,
      );
      if (!lockResult.acquired) {
        // Notify about conflict
        if (this.eventBus) {
          void this.eventBus.publish('session.conflict', {
            userId: request.userId,
            sessionId: request.sessionId,
            channelId: request.channelId,
            platform: request.platform,
            workingDirectory: request.workingDirectory,
            conflictingSessionId: lockResult.heldBy?.sessionId,
          });
        }

        // Wait for lock to be released
        const acquired = await this.waitForDirectoryLock(request);
        if (!acquired) {
          yield { ...base, type: 'error', error: 'directory busy — request timed out' };
          return;
        }
      }
    }

    // Check concurrency — queue if at cap, reject if queue also full
    if (this.activeConcurrent >= this.maxConcurrent) {
      const queued = await this.tryEnqueue(request);
      if (!queued) {
        if (request.workingDirectory) {
          this.directoryLock.release(request.workingDirectory, request.sessionId);
        }
        yield { ...base, type: 'error', error: 'server busy' };
        return;
      }
    }

    // Track session
    this.sessionManager.getOrCreate(request.sessionId);

    // Execute backend and yield events
    this.activeConcurrent += 1;
    try {
      for await (const event of this.backend.execute(request)) {
        // Publish progress events to the event bus
        if (this.eventBus !== undefined && (event.type === 'text' || event.type === 'tool_use')) {
          const progressPayload = {
            userId: event.userId,
            sessionId: event.sessionId,
            channelId: event.channelId,
            platform: event.platform,
            type: event.type as 'text' | 'tool_use',
            content: event.type === 'text' ? event.content : event.tool,
          };
          void this.eventBus.publish('agent.progress', progressPayload);
        }
        yield event;
      }
    } finally {
      this.activeConcurrent -= 1;
      // Release directory lock and drain directory queue
      if (request.workingDirectory) {
        this.directoryLock.release(request.workingDirectory, request.sessionId);
        this.drainDirectoryQueue(request.workingDirectory);
      }
      this.drainQueue();
    }
  }

  private tryEnqueue(request: AgentRequest): Promise<boolean> {
    return new Promise<boolean>((outerResolve) => {
      // Placeholder so TypeScript accepts the forward reference
      const queued = {} as QueuedRequest;

      queued.request = request;
      queued.resolve = () => {
        clearTimeout(queued.timer);
        outerResolve(true);
      };
      queued.reject = () => outerResolve(false);

      const priority = request.permissionLevel as QueuePriority;
      const enqueued = this.queue.enqueue(queued, priority);
      if (!enqueued) {
        outerResolve(false);
        return;
      }

      // Set a timeout to remove from queue if not processed in time
      queued.timer = setTimeout(() => {
        // Remove this specific item from the queue so it doesn't linger
        this.queue.remove(queued);
        queued.reject(new Error('queue timeout'));
      }, this.queueTimeoutSeconds * 1000);
    });
  }

  private waitForDirectoryLock(request: AgentRequest): Promise<boolean> {
    return new Promise<boolean>((promiseResolve) => {
      const dir = resolvePath(request.workingDirectory!);
      const entry = {
        resolve: () => {
          clearTimeout(entry.timer);
          const result = this.directoryLock.acquire(dir, request.sessionId, request.userId);
          promiseResolve(result.acquired);
        },
        reject: () => promiseResolve(false),
        timer: setTimeout(() => {
          const queue = this.directoryQueue.get(dir);
          if (queue) {
            const idx = queue.indexOf(entry);
            if (idx !== -1) queue.splice(idx, 1);
            if (queue.length === 0) this.directoryQueue.delete(dir);
          }
          promiseResolve(false);
        }, this.queueTimeoutSeconds * 1000),
      };

      if (!this.directoryQueue.has(dir)) {
        this.directoryQueue.set(dir, []);
      }
      this.directoryQueue.get(dir)!.push(entry);
    });
  }

  private drainDirectoryQueue(workingDirectory: string): void {
    const dir = resolvePath(workingDirectory);
    const queue = this.directoryQueue.get(dir);
    if (!queue || queue.length === 0) return;

    const next = queue.shift()!;
    if (queue.length === 0) this.directoryQueue.delete(dir);

    clearTimeout(next.timer);
    next.resolve();
  }

  private drainQueue(): void {
    while (this.activeConcurrent < this.maxConcurrent) {
      const next = this.queue.dequeue();
      if (next === undefined) break;
      clearTimeout(next.timer);
      next.resolve();
    }
  }

  async abort(sessionId: string): Promise<void> {
    await this.backend.abort(sessionId);
    this.sessionManager.remove(sessionId);
  }

  tick(): void {
    this.sessionManager.tick();
  }

  getActiveSessions(): Session[] {
    return this.sessionManager.getActiveSessions();
  }

  get queueSize(): number {
    return this.queue.size;
  }
}
