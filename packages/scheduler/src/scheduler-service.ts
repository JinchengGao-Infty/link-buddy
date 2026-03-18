import { CronRunner } from './cron-runner.js';
import { HeartbeatMonitor } from './heartbeat.js';
import { WebhookServer } from './webhook-server.js';
import type { SchedulerDeps, ScheduledJob } from './types.js';

export class SchedulerService {
  private cronRunner: CronRunner;
  private heartbeat: HeartbeatMonitor | null = null;
  private webhookServer: WebhookServer | null = null;
  private readonly deps: SchedulerDeps;
  private readonly jobs: ScheduledJob[] = [];

  constructor(deps: SchedulerDeps) {
    this.deps = deps;
    this.cronRunner = new CronRunner({
      eventBus: deps.eventBus,
      executeAgentRequest: deps.executeAgentRequest,
      sendProactiveMessage: deps.sendProactiveMessage,
      runSkill: deps.runSkill,
      timezone: deps.config.scheduler.timezone,
    });
  }

  async start(): Promise<void> {
    this.registerCronJobs();
    this.startHeartbeat();
    await this.startWebhooks();
    console.log('[Scheduler] Started');
  }

  async stop(): Promise<void> {
    this.cronRunner.stop();
    if (this.heartbeat) this.heartbeat.stop();
    if (this.webhookServer) await this.webhookServer.stop();
    console.log('[Scheduler] Stopped');
  }

  getJobs(): readonly ScheduledJob[] {
    return this.jobs;
  }

  private registerCronJobs(): void {
    const { jobs, default_target } = this.deps.config.scheduler;
    if (!jobs) return;

    for (const [name, jobConfig] of Object.entries(jobs)) {
      const target = jobConfig.target ?? default_target;
      if (!target) {
        console.warn(`[Scheduler] Job "${name}" has no target and no default_target — skipping`);
        continue;
      }

      const job: ScheduledJob = {
        name,
        cron: jobConfig.cron,
        type: jobConfig.skill ? 'skill' : 'prompt',
        payload: jobConfig.skill ?? jobConfig.prompt ?? '',
        user: jobConfig.user,
        target,
        permissionLevel: jobConfig.permission_level ?? 'system',
        enabled: jobConfig.enabled !== false,
        nextRun: 0,
        running: false,
      };

      this.jobs.push(job);
      this.cronRunner.registerJob(job);
    }
  }

  private startHeartbeat(): void {
    const { heartbeat: hbConfig } = this.deps.config;

    this.heartbeat = new HeartbeatMonitor({
      eventBus: this.deps.eventBus,
      sendProactiveMessage: this.deps.sendProactiveMessage,
      alertTarget: hbConfig.alert_target,
      intervalSeconds: hbConfig.interval_seconds,
      checks: hbConfig.checks,
      checkDatabase: this.deps.checkDatabase,
      checkAgent: this.deps.checkAgent,
      dailyReportCron: hbConfig.daily_report_cron,
    });

    this.heartbeat.start();
  }

  private async startWebhooks(): Promise<void> {
    const { webhooks: whConfig } = this.deps.config;
    if (!whConfig.enabled) return;

    const endpoints: Record<string, import('./webhook-server.js').WebhookEndpoint> = {};
    if (whConfig.endpoints) {
      for (const [name, epConfig] of Object.entries(whConfig.endpoints)) {
        if (epConfig.enabled === false) continue;

        const target = epConfig.target ?? this.deps.config.scheduler.default_target;
        if (!target) {
          console.warn(`[Scheduler] Webhook endpoint "${name}" has no target — skipping`);
          continue;
        }

        endpoints[name] = {
          path: epConfig.path,
          secret_env: epConfig.secret_env,
          signature_header: epConfig.signature_header,
          signature_algorithm: epConfig.signature_algorithm,
          prompt_template: epConfig.prompt_template,
          max_payload_chars: epConfig.max_payload_chars,
          user: epConfig.user,
          target,
        };
      }
    }

    this.webhookServer = new WebhookServer({
      port: whConfig.port,
      endpoints,
      eventBus: this.deps.eventBus,
      executeAgentRequest: this.deps.executeAgentRequest,
      sendProactiveMessage: this.deps.sendProactiveMessage,
    });

    await this.webhookServer.start();
  }
}
