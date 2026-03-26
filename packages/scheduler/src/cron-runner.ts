import { readFileSync, writeFileSync, watchFile, unwatchFile } from 'node:fs';
import nodeCron, { type ScheduledTask } from 'node-cron';
import type {
  EventBus,
  AgentRequest,
  AgentEvent,
  MessageTarget,
  HeartbeatJobConfig,
} from '@ccbuddy/core';
import type { ScheduledJob, PromptJob, SkillJob, InternalJob } from './types.js';

export interface CronRunnerOptions {
  eventBus: EventBus;
  executeAgentRequest: (request: AgentRequest) => AsyncGenerator<AgentEvent>;
  sendProactiveMessage: (target: MessageTarget, text: string) => Promise<void>;
  runSkill?: (name: string, input: Record<string, unknown>) => Promise<string>;
  assembleContext: (userId: string, sessionId: string) => string;
  timezone: string;
  internalJobs?: Map<string, () => Promise<void>>;
}

export class CronRunner {
  private readonly tasks = new Map<string, ScheduledTask>();
  private readonly jobs = new Map<string, ScheduledJob>();
  private readonly opts: CronRunnerOptions;
  private heartbeatConfigFile: string | null = null;
  private heartbeatActiveHours: { start: string; end: string } | undefined;
  private heartbeatFile: string = './HEARTBEAT.md';

  constructor(opts: CronRunnerOptions) {
    this.opts = opts;
  }

  registerJob(job: ScheduledJob): void {
    if (!job.enabled) return;

    if (!nodeCron.validate(job.cron)) {
      console.error(`[Scheduler] Invalid cron expression '${job.cron}' for job '${job.name}' — skipping`);
      return;
    }

    // Stop previous task if re-registering same job name
    const existing = this.tasks.get(job.name);
    if (existing) existing.stop();

    const task = nodeCron.schedule(
      job.cron,
      () => {
        void this.executeJob(job);
      },
      { timezone: job.timezone ?? this.opts.timezone },
    );

    this.tasks.set(job.name, task);
    this.jobs.set(job.name, job);
  }

  async executeJob(job: ScheduledJob): Promise<void> {
    if (job.running) return;

    job.running = true;
    try {
      if (job.type === 'internal') {
        await this.executeInternalJob(job);
      } else if (job.type === 'skill') {
        await this.executeSkillJob(job);
      } else {
        await this.executePromptJob(job);
      }
    } finally {
      job.running = false;
    }
  }

  registerHeartbeat(config: HeartbeatJobConfig, configFile?: string): void {
    if (config.enabled === false) return;
    const target = config.target;
    if (!target) {
      console.warn('[Scheduler] Heartbeat has no target — skipping');
      return;
    }

    this.heartbeatFile = config.heartbeat_file ?? './HEARTBEAT.md';
    this.heartbeatActiveHours = config.active_hours;

    const job: PromptJob = {
      name: 'heartbeat',
      cron: config.cron,
      type: 'prompt',
      payload: '', // will be built dynamically
      user: config.user,
      target,
      permissionLevel: 'admin',
      enabled: true,
      nextRun: 0,
      running: false,
    };

    this.scheduleHeartbeatTask(job, config.cron);

    // Watch heartbeat-config.json for runtime cron changes
    if (configFile) {
      this.heartbeatConfigFile = configFile;
      this.watchHeartbeatConfig(configFile, job);
    }
  }

  private scheduleHeartbeatTask(job: PromptJob, cron: string): void {
    // Stop existing task if any
    const existing = this.tasks.get('heartbeat');
    if (existing) existing.stop();

    const task = nodeCron.schedule(
      cron,
      () => {
        if (this.heartbeatActiveHours) {
          const now = new Date();
          const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
          if (hhmm < this.heartbeatActiveHours.start || hhmm >= this.heartbeatActiveHours.end) return;
        }
        void this.executeHeartbeat(job, this.heartbeatFile);
      },
      { timezone: this.opts.timezone },
    );

    job.cron = cron;
    this.tasks.set('heartbeat', task);
    this.jobs.set('heartbeat', job);
  }

  private watchHeartbeatConfig(configFile: string, job: PromptJob): void {
    watchFile(configFile, { interval: 5000 }, () => {
      try {
        const raw = readFileSync(configFile, 'utf-8').trim();
        if (!raw) return;
        const cfg = JSON.parse(raw) as { cron?: string; active_hours?: { start: string; end: string } };

        if (cfg.cron && nodeCron.validate(cfg.cron) && cfg.cron !== job.cron) {
          console.log(`[Heartbeat] Cron updated: ${job.cron} → ${cfg.cron}`);
          this.scheduleHeartbeatTask(job, cfg.cron);
        }

        if (cfg.active_hours) {
          this.heartbeatActiveHours = cfg.active_hours;
        }
      } catch {
        // Ignore parse errors — file may be mid-write
      }
    });
  }

  private async executeHeartbeat(job: PromptJob, heartbeatFile: string): Promise<void> {
    if (job.running) return;
    job.running = true;

    try {
      let checklist = '';
      try {
        checklist = readFileSync(heartbeatFile, 'utf-8').trim();
      } catch {
        // No HEARTBEAT.md — skip silently
        return;
      }
      if (!checklist) return;

      const prompt = [
        'This is a scheduled heartbeat check. Read the checklist below and determine if anything needs my attention.',
        'If nothing needs attention, reply with exactly "HEARTBEAT_OK" and nothing else.',
        'If something needs attention, send a brief notification.',
        '',
        '---',
        checklist,
      ].join('\n');

      const memoryContext = this.opts.assembleContext(job.user, '*');
      const sessionId = `scheduler:heartbeat:${Date.now()}`;
      const request: AgentRequest = {
        prompt,
        userId: job.user,
        sessionId,
        channelId: job.target.channel,
        platform: job.target.platform,
        permissionLevel: job.permissionLevel,
        memoryContext,
      };

      for await (const event of this.opts.executeAgentRequest(request)) {
        if (event.type === 'complete') {
          const response = event.response.trim();
          // Suppress if agent says nothing needs attention
          if (response === 'HEARTBEAT_OK' || response.startsWith('HEARTBEAT_OK')) {
            console.log('[Heartbeat] All clear — suppressed');
          } else {
            await this.opts.sendProactiveMessage(job.target, response);
          }
          return;
        }
        if (event.type === 'error') {
          console.error('[Heartbeat] Error:', event.error);
          return;
        }
      }
    } finally {
      job.running = false;
    }
  }

  stop(): void {
    for (const task of this.tasks.values()) {
      task.stop();
    }
    this.tasks.clear();
    this.jobs.clear();
    if (this.heartbeatConfigFile) {
      unwatchFile(this.heartbeatConfigFile);
    }
  }

  private async executePromptJob(job: PromptJob): Promise<void> {
    // Use '*' session to query across all sessions (scheduler has no single session)
    const memoryContext = this.opts.assembleContext(job.user, '*');
    const sessionId = `scheduler:cron:${job.name}:${Date.now()}`;

    const request: AgentRequest = {
      prompt: job.payload,
      userId: job.user,
      sessionId,
      channelId: job.target.channel,
      platform: job.target.platform,
      permissionLevel: job.permissionLevel,
      memoryContext,
    };

    const generator = this.opts.executeAgentRequest(request);
    try {
      for await (const event of generator) {
        if (event.type === 'error') {
          await this.handleError(job, event.error);
          return;
        }
        if (event.type === 'complete') {
          await this.opts.sendProactiveMessage(job.target, event.response);
          await this.publishComplete(job, true);
          return;
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.handleError(job, message);
    }
  }

  private async executeSkillJob(job: SkillJob): Promise<void> {
    if (!this.opts.runSkill) {
      await this.handleError(job, 'runSkill not configured');
      return;
    }

    try {
      const result = await this.opts.runSkill(job.payload, {});
      await this.opts.sendProactiveMessage(job.target, result);
      await this.publishComplete(job, true);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.handleError(job, message);
    }
  }

  private async handleError(job: PromptJob | SkillJob, error: string): Promise<void> {
    await this.opts.sendProactiveMessage(
      job.target,
      `Scheduled job "${job.name}" failed: ${error}`,
    );
    await this.publishComplete(job, false);
  }

  private async publishComplete(job: PromptJob | SkillJob, success: boolean): Promise<void> {
    await this.opts.eventBus.publish('scheduler.job.complete', {
      jobName: job.name,
      source: 'cron',
      success,
      target: job.target,
      timestamp: Date.now(),
    });
  }

  private async executeInternalJob(job: InternalJob): Promise<void> {
    const callback = this.opts.internalJobs?.get(job.name);
    if (!callback) {
      console.error(`[Scheduler] Internal job "${job.name}" has no registered callback`);
      await this.opts.eventBus.publish('scheduler.job.complete', {
        jobName: job.name,
        source: 'cron' as const,
        success: false,
        target: { platform: 'system', channel: 'internal' },
        timestamp: Date.now(),
      });
      return;
    }

    try {
      await callback();
      await this.opts.eventBus.publish('scheduler.job.complete', {
        jobName: job.name,
        source: 'cron' as const,
        success: true,
        target: { platform: 'system', channel: 'internal' },
        timestamp: Date.now(),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[Scheduler] Internal job "${job.name}" failed:`, message);
      await this.opts.eventBus.publish('scheduler.job.complete', {
        jobName: job.name,
        source: 'cron' as const,
        success: false,
        target: { platform: 'system', channel: 'internal' },
        timestamp: Date.now(),
      });
    }
  }
}
