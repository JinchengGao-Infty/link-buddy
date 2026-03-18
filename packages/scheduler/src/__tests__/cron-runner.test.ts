import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentEvent, AgentRequest, MessageTarget, EventBus } from '@ccbuddy/core';
import type { ScheduledJob } from '../types.js';

const { mockSchedule, mockValidate } = vi.hoisted(() => ({
  mockSchedule: vi.fn(() => ({ stop: vi.fn() })),
  mockValidate: vi.fn(() => true),
}));

vi.mock('node-cron', () => ({
  default: {
    schedule: mockSchedule,
    validate: mockValidate,
  },
  schedule: mockSchedule,
  validate: mockValidate,
}));

import { CronRunner, type CronRunnerOptions } from '../cron-runner.js';

function createMockTarget(): MessageTarget {
  return { platform: 'discord', channel: 'general' };
}

function createMockJob(overrides: Partial<ScheduledJob> = {}): ScheduledJob {
  return {
    name: 'daily-report',
    cron: '0 9 * * *',
    type: 'prompt',
    payload: 'Give me a daily summary',
    user: 'user-123',
    target: createMockTarget(),
    permissionLevel: 'system',
    enabled: true,
    nextRun: Date.now() + 60_000,
    running: false,
    ...overrides,
  };
}

function createMockDeps(overrides: Partial<CronRunnerOptions> = {}): CronRunnerOptions {
  const completeEvent: AgentEvent = {
    type: 'complete',
    response: 'Here is your daily report.',
    sessionId: 'test-session',
    userId: 'user-123',
    channelId: 'general',
    platform: 'discord',
  };

  const executeAgentRequest = vi.fn(async function* (_req: AgentRequest): AsyncGenerator<AgentEvent> {
    yield completeEvent;
  });

  const sendProactiveMessage = vi.fn(async () => {});

  const runSkill = vi.fn(async () => 'skill-result-text');

  const eventBus: EventBus = {
    publish: vi.fn(async () => {}),
    subscribe: vi.fn(() => ({ dispose: vi.fn() })),
  };

  return {
    eventBus,
    executeAgentRequest,
    sendProactiveMessage,
    runSkill,
    timezone: 'UTC',
    ...overrides,
  };
}

describe('CronRunner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('registerJob', () => {
    it('registers a job with node-cron schedule()', () => {
      const deps = createMockDeps();
      const runner = new CronRunner(deps);
      const job = createMockJob();

      runner.registerJob(job);

      expect(mockSchedule).toHaveBeenCalledWith(
        job.cron,
        expect.any(Function),
        expect.objectContaining({ timezone: 'UTC' }),
      );
    });

    it('skips disabled jobs', () => {
      const deps = createMockDeps();
      const runner = new CronRunner(deps);
      const job = createMockJob({ enabled: false });

      runner.registerJob(job);

      expect(mockSchedule).not.toHaveBeenCalled();
    });
  });

  describe('executeJob — prompt', () => {
    it('builds AgentRequest with correct fields and sends response', async () => {
      const deps = createMockDeps();
      const runner = new CronRunner(deps);
      const job = createMockJob();

      await runner.executeJob(job);

      // Verify executeAgentRequest was called with correct AgentRequest
      expect(deps.executeAgentRequest).toHaveBeenCalledTimes(1);
      const request: AgentRequest = (deps.executeAgentRequest as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(request.prompt).toBe('Give me a daily summary');
      expect(request.userId).toBe('user-123');
      expect(request.sessionId).toMatch(/^scheduler:cron:daily-report:\d+$/);
      expect(request.channelId).toBe('general');
      expect(request.platform).toBe('discord');
      expect(request.permissionLevel).toBe('system');

      // Verify sendProactiveMessage was called with the response
      expect(deps.sendProactiveMessage).toHaveBeenCalledWith(
        job.target,
        'Here is your daily report.',
      );
    });
  });

  describe('executeJob — skill', () => {
    it('calls runSkill instead of executeAgentRequest', async () => {
      const deps = createMockDeps();
      const runner = new CronRunner(deps);
      const job = createMockJob({ type: 'skill', payload: 'check-health' });

      await runner.executeJob(job);

      expect(deps.runSkill).toHaveBeenCalledWith('check-health', {});
      expect(deps.executeAgentRequest).not.toHaveBeenCalled();
      expect(deps.sendProactiveMessage).toHaveBeenCalledWith(
        job.target,
        'skill-result-text',
      );
    });
  });

  describe('executeJob — events', () => {
    it('publishes scheduler.job.complete event on success', async () => {
      const deps = createMockDeps();
      const runner = new CronRunner(deps);
      const job = createMockJob();

      await runner.executeJob(job);

      expect(deps.eventBus.publish).toHaveBeenCalledWith(
        'scheduler.job.complete',
        expect.objectContaining({
          jobName: 'daily-report',
          source: 'cron',
          success: true,
          target: job.target,
          timestamp: expect.any(Number),
        }),
      );
    });
  });

  describe('executeJob — overlap prevention', () => {
    it('skips execution if job.running is true', async () => {
      const deps = createMockDeps();
      const runner = new CronRunner(deps);
      const job = createMockJob({ running: true });

      await runner.executeJob(job);

      expect(deps.executeAgentRequest).not.toHaveBeenCalled();
      expect(deps.sendProactiveMessage).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('sends error alert and publishes failure event on agent error', async () => {
      const errorEvent: AgentEvent = {
        type: 'error',
        error: 'Agent failed to process',
        sessionId: 'test-session',
        userId: 'user-123',
        channelId: 'general',
        platform: 'discord',
      };

      const executeAgentRequest = vi.fn(async function* (): AsyncGenerator<AgentEvent> {
        yield errorEvent;
      });

      const deps = createMockDeps({ executeAgentRequest });
      const runner = new CronRunner(deps);
      const job = createMockJob();

      await runner.executeJob(job);

      // Should send error alert to target
      expect(deps.sendProactiveMessage).toHaveBeenCalledWith(
        job.target,
        expect.stringContaining('Agent failed to process'),
      );

      // Should publish failure event
      expect(deps.eventBus.publish).toHaveBeenCalledWith(
        'scheduler.job.complete',
        expect.objectContaining({
          jobName: 'daily-report',
          source: 'cron',
          success: false,
          target: job.target,
          timestamp: expect.any(Number),
        }),
      );
    });
  });

  describe('stop', () => {
    it('calls stop() on all registered cron tasks', () => {
      const mockTask = { stop: vi.fn() };
      mockSchedule.mockReturnValue(mockTask);

      const deps = createMockDeps();
      const runner = new CronRunner(deps);

      runner.registerJob(createMockJob({ name: 'job-a' }));
      runner.registerJob(createMockJob({ name: 'job-b' }));

      runner.stop();

      expect(mockTask.stop).toHaveBeenCalledTimes(2);
    });
  });
});
