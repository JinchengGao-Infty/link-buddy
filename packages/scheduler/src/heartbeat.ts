import os from 'node:os';
import type {
  EventBus,
  MessageTarget,
} from '@ccbuddy/core';

export interface HeartbeatOptions {
  eventBus: EventBus;
  sendProactiveMessage: (target: MessageTarget, text: string) => Promise<void>;
  alertTarget?: MessageTarget;
  intervalSeconds: number;
  checks: { process: boolean; database: boolean; agent: boolean };
  checkDatabase: () => Promise<boolean>;
  checkAgent: () => Promise<{ reachable: boolean; durationMs: number }>;
  dailyReportCron?: string;
}

type ModuleStatus = 'healthy' | 'degraded' | 'down';

export class HeartbeatMonitor {
  private readonly opts: HeartbeatOptions;
  private readonly previousStatus: Record<string, ModuleStatus>;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private dailyReportTimeout: ReturnType<typeof setTimeout> | null = null;
  private readonly startTime: number;

  constructor(opts: HeartbeatOptions) {
    this.opts = opts;
    this.startTime = Date.now();

    // Initialize previousStatus with all enabled checks set to 'healthy'
    this.previousStatus = {};
    if (opts.checks.process) this.previousStatus['process'] = 'healthy';
    if (opts.checks.database) this.previousStatus['database'] = 'healthy';
    if (opts.checks.agent) this.previousStatus['agent'] = 'healthy';
  }

  start(): void {
    this.intervalHandle = setInterval(() => {
      void this.runChecks();
    }, this.opts.intervalSeconds * 1000);

    if (this.opts.dailyReportCron) {
      this.scheduleDailyReport();
    }
  }

  stop(): void {
    if (this.intervalHandle !== null) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    if (this.dailyReportTimeout !== null) {
      clearTimeout(this.dailyReportTimeout);
      this.dailyReportTimeout = null;
    }
  }

  async runChecks(): Promise<void> {
    const modules: Record<string, ModuleStatus> = {};

    // Process check
    if (this.opts.checks.process) {
      modules['process'] = this.checkProcess();
    }

    // Database check
    if (this.opts.checks.database) {
      modules['database'] = await this.checkDatabase();
    }

    // Agent check
    if (this.opts.checks.agent) {
      modules['agent'] = await this.checkAgent();
    }

    // Gather system metrics
    const system = this.getSystemMetrics();

    // Publish heartbeat.status event
    await this.opts.eventBus.publish('heartbeat.status', {
      modules,
      system,
      timestamp: Date.now(),
    });

    // Check for state transitions and alert
    await this.handleTransitions(modules);

    // Update previous status
    for (const [key, status] of Object.entries(modules)) {
      this.previousStatus[key] = status;
    }
  }

  private checkProcess(): ModuleStatus {
    const rss = process.memoryUsage().rss;
    const rssMB = rss / (1024 * 1024);
    return rssMB > 512 ? 'degraded' : 'healthy';
  }

  private async checkDatabase(): Promise<ModuleStatus> {
    try {
      await this.opts.checkDatabase();
      return 'healthy';
    } catch {
      return 'down';
    }
  }

  private async checkAgent(): Promise<ModuleStatus> {
    try {
      const result = await this.opts.checkAgent();
      if (!result.reachable) return 'down';
      if (result.durationMs > 5000) return 'degraded';
      return 'healthy';
    } catch {
      return 'down';
    }
  }

  private getSystemMetrics(): { cpuPercent: number; memoryPercent: number; diskPercent: number } {
    // CPU percent from os.cpus()
    const cpus = os.cpus();
    let totalIdle = 0;
    let totalTick = 0;
    for (const cpu of cpus) {
      totalIdle += cpu.times.idle;
      totalTick += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.irq + cpu.times.idle;
    }
    const cpuPercent = totalTick > 0 ? Math.round(((totalTick - totalIdle) / totalTick) * 100) : 0;

    // Memory percent: RSS / total system memory
    const rss = process.memoryUsage().rss;
    const totalMem = os.totalmem();
    const memoryPercent = totalMem > 0 ? Math.round((rss / totalMem) * 10000) / 100 : 0;

    // Disk check deferred
    const diskPercent = 0;

    return { cpuPercent, memoryPercent, diskPercent };
  }

  private async handleTransitions(modules: Record<string, ModuleStatus>): Promise<void> {
    for (const [module, currentStatus] of Object.entries(modules)) {
      const previousStatus = this.previousStatus[module];
      if (!previousStatus) continue;

      // Degraded/down transition: alert when going from healthy->degraded, healthy->down, degraded->down
      const isDegrading =
        (previousStatus === 'healthy' && (currentStatus === 'degraded' || currentStatus === 'down')) ||
        (previousStatus === 'degraded' && currentStatus === 'down');

      if (isDegrading) {
        // Send alert
        if (this.opts.alertTarget) {
          await this.opts.sendProactiveMessage(
            this.opts.alertTarget,
            `[Alert] Module "${module}" is ${currentStatus}.`,
          );
        }
        // Publish alert.health event
        await this.opts.eventBus.publish('alert.health', {
          module,
          status: currentStatus as 'degraded' | 'down',
          message: `Module "${module}" transitioned from ${previousStatus} to ${currentStatus}`,
          timestamp: Date.now(),
        });
      }

      // Recovery transition: from degraded/down back to healthy
      const isRecovery =
        (previousStatus === 'degraded' || previousStatus === 'down') &&
        currentStatus === 'healthy';

      if (isRecovery) {
        if (this.opts.alertTarget) {
          await this.opts.sendProactiveMessage(
            this.opts.alertTarget,
            `[Recovered] Module "${module}" has recovered and is now healthy.`,
          );
        }
      }
    }
  }

  private scheduleDailyReport(): void {
    if (!this.opts.dailyReportCron) return;

    const msUntilNext = this.msUntilNextCron(this.opts.dailyReportCron);
    this.dailyReportTimeout = setTimeout(() => {
      void this.sendDailyReport().then(() => {
        this.scheduleDailyReport();
      });
    }, msUntilNext);
  }

  private msUntilNextCron(cronExpr: string): number {
    // Parse simple "minute hour * * *" cron format
    const parts = cronExpr.trim().split(/\s+/);
    const minute = parseInt(parts[0], 10);
    const hour = parseInt(parts[1], 10);

    const now = new Date();
    const next = new Date(now);
    next.setHours(hour, minute, 0, 0);

    if (next.getTime() <= now.getTime()) {
      next.setDate(next.getDate() + 1);
    }

    return next.getTime() - now.getTime();
  }

  private async sendDailyReport(): Promise<void> {
    if (!this.opts.alertTarget) return;

    // Only send when all checks are healthy
    const allHealthy = Object.values(this.previousStatus).every((s) => s === 'healthy');
    if (!allHealthy) return;

    const uptimeMs = Date.now() - this.startTime;
    const uptimeHours = Math.round(uptimeMs / (1000 * 60 * 60) * 10) / 10;
    const rss = process.memoryUsage().rss;
    const rssMB = Math.round(rss / (1024 * 1024));

    const statuses = Object.entries(this.previousStatus)
      .map(([mod, status]) => `  ${mod}: ${status}`)
      .join('\n');

    const report = [
      '[Daily Health Report]',
      `Uptime: ${uptimeHours}h`,
      `Memory (RSS): ${rssMB}MB`,
      `Module Statuses:`,
      statuses,
    ].join('\n');

    await this.opts.sendProactiveMessage(this.opts.alertTarget, report);
  }
}
