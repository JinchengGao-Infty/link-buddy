import nodeCron, { type ScheduledTask } from 'node-cron';
import type {
  EventBus,
  AgentRequest,
  AgentEvent,
  MessageTarget,
} from '@ccbuddy/core';
import type { ScheduledJob } from './types.js';

export interface CronRunnerOptions {
  eventBus: EventBus;
  executeAgentRequest: (request: AgentRequest) => AsyncGenerator<AgentEvent>;
  sendProactiveMessage: (target: MessageTarget, text: string) => Promise<void>;
  runSkill?: (name: string, input: Record<string, unknown>) => Promise<string>;
  timezone: string;
}

export class CronRunner {
  private readonly tasks = new Map<string, ScheduledTask>();
  private readonly jobs = new Map<string, ScheduledJob>();
  private readonly opts: CronRunnerOptions;

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
      { timezone: this.opts.timezone },
    );

    this.tasks.set(job.name, task);
    this.jobs.set(job.name, job);
  }

  async executeJob(job: ScheduledJob): Promise<void> {
    if (job.running) return;

    job.running = true;
    try {
      if (job.type === 'skill') {
        await this.executeSkillJob(job);
      } else {
        await this.executePromptJob(job);
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
  }

  private async executePromptJob(job: ScheduledJob): Promise<void> {
    const request: AgentRequest = {
      prompt: job.payload,
      userId: job.user,
      sessionId: `scheduler:cron:${job.name}:${Date.now()}`,
      channelId: job.target.channel,
      platform: job.target.platform,
      permissionLevel: job.permissionLevel,
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

  private async executeSkillJob(job: ScheduledJob): Promise<void> {
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

  private async handleError(job: ScheduledJob, error: string): Promise<void> {
    await this.opts.sendProactiveMessage(
      job.target,
      `Scheduled job "${job.name}" failed: ${error}`,
    );
    await this.publishComplete(job, false);
  }

  private async publishComplete(job: ScheduledJob, success: boolean): Promise<void> {
    await this.opts.eventBus.publish('scheduler.job.complete', {
      jobName: job.name,
      source: 'cron',
      success,
      target: job.target,
      timestamp: Date.now(),
    });
  }
}
