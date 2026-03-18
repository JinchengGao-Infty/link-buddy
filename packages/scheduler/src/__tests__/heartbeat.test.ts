import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { EventBus, MessageTarget } from '@ccbuddy/core';
import type { HeartbeatOptions } from '../heartbeat.js';

function createMockDeps(overrides: Partial<HeartbeatOptions> = {}): HeartbeatOptions {
  const eventBus: EventBus = {
    publish: vi.fn(async () => {}),
    subscribe: vi.fn(() => ({ dispose: vi.fn() })),
  };

  const alertTarget: MessageTarget = { platform: 'discord', channel: 'alerts' };

  return {
    eventBus,
    sendProactiveMessage: vi.fn(async () => {}),
    alertTarget,
    intervalSeconds: 30,
    checks: { process: true, database: true, agent: true },
    checkDatabase: vi.fn(async () => true),
    checkAgent: vi.fn(async () => ({ reachable: true, durationMs: 100 })),
    ...overrides,
  };
}

// Must import after vi.mock calls if needed, but HeartbeatMonitor uses
// only Node built-ins (os, process) which we don't need to mock for most tests.
import { HeartbeatMonitor } from '../heartbeat.js';

describe('HeartbeatMonitor', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('runChecks — all healthy', () => {
    it('publishes heartbeat.status event with modules all healthy and system metrics', async () => {
      const deps = createMockDeps();
      const monitor = new HeartbeatMonitor(deps);

      await monitor.runChecks();

      expect(deps.eventBus.publish).toHaveBeenCalledWith(
        'heartbeat.status',
        expect.objectContaining({
          modules: expect.objectContaining({
            process: 'healthy',
            database: 'healthy',
            agent: 'healthy',
          }),
          system: expect.objectContaining({
            cpuPercent: expect.any(Number),
            memoryPercent: expect.any(Number),
            diskPercent: expect.any(Number),
          }),
          timestamp: expect.any(Number),
        }),
      );
    });
  });

  describe('runChecks — database failure', () => {
    it('sets modules.database to down when checkDatabase rejects', async () => {
      const deps = createMockDeps({
        checkDatabase: vi.fn(async () => { throw new Error('connection refused'); }),
      });
      const monitor = new HeartbeatMonitor(deps);

      await monitor.runChecks();

      expect(deps.eventBus.publish).toHaveBeenCalledWith(
        'heartbeat.status',
        expect.objectContaining({
          modules: expect.objectContaining({
            database: 'down',
          }),
        }),
      );
    });
  });

  describe('runChecks — slow agent', () => {
    it('sets modules.agent to degraded when durationMs > 5000', async () => {
      const deps = createMockDeps({
        checkAgent: vi.fn(async () => ({ reachable: true, durationMs: 6000 })),
      });
      const monitor = new HeartbeatMonitor(deps);

      await monitor.runChecks();

      expect(deps.eventBus.publish).toHaveBeenCalledWith(
        'heartbeat.status',
        expect.objectContaining({
          modules: expect.objectContaining({
            agent: 'degraded',
          }),
        }),
      );
    });
  });

  describe('state transitions — healthy to down', () => {
    it('sends alert and publishes alert.health on transition from healthy to down', async () => {
      const deps = createMockDeps();
      const monitor = new HeartbeatMonitor(deps);

      // First check: all healthy — no alert expected
      await monitor.runChecks();
      expect(deps.sendProactiveMessage).not.toHaveBeenCalled();

      // Make database fail
      (deps.checkDatabase as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('db down'));

      // Second check: database down — should alert
      await monitor.runChecks();

      expect(deps.sendProactiveMessage).toHaveBeenCalledTimes(1);
      expect(deps.eventBus.publish).toHaveBeenCalledWith(
        'alert.health',
        expect.objectContaining({
          module: 'database',
          status: 'down',
          message: expect.any(String),
          timestamp: expect.any(Number),
        }),
      );
    });
  });

  describe('state transitions — no repeated alerts', () => {
    it('only sends one alert when module stays down across multiple checks', async () => {
      const deps = createMockDeps({
        checkDatabase: vi.fn(async () => { throw new Error('db down'); }),
      });
      const monitor = new HeartbeatMonitor(deps);

      // First check: transition healthy->down, should alert
      await monitor.runChecks();
      expect(deps.sendProactiveMessage).toHaveBeenCalledTimes(1);

      // Second check: stays down, no new alert
      await monitor.runChecks();
      expect(deps.sendProactiveMessage).toHaveBeenCalledTimes(1);

      // Third check: still down, still no new alert
      await monitor.runChecks();
      expect(deps.sendProactiveMessage).toHaveBeenCalledTimes(1);
    });
  });

  describe('state transitions — recovery', () => {
    it('sends recovery message when module goes from down to healthy', async () => {
      const checkDatabase = vi.fn<() => Promise<boolean>>().mockRejectedValue(new Error('db down'));
      const deps = createMockDeps({ checkDatabase });
      const monitor = new HeartbeatMonitor(deps);

      // First check: down
      await monitor.runChecks();
      expect(deps.sendProactiveMessage).toHaveBeenCalledTimes(1);

      // Recover
      checkDatabase.mockResolvedValue(true);

      // Second check: healthy again
      await monitor.runChecks();
      expect(deps.sendProactiveMessage).toHaveBeenCalledTimes(2);

      const recoveryMessage = (deps.sendProactiveMessage as ReturnType<typeof vi.fn>).mock.calls[1][1] as string;
      expect(recoveryMessage.toLowerCase()).toContain('recovered');
    });
  });

  describe('skips disabled checks', () => {
    it('only runs checks that are enabled in config', async () => {
      const deps = createMockDeps({
        checks: { process: true, database: false, agent: false },
      });
      const monitor = new HeartbeatMonitor(deps);

      await monitor.runChecks();

      expect(deps.checkDatabase).not.toHaveBeenCalled();
      expect(deps.checkAgent).not.toHaveBeenCalled();

      expect(deps.eventBus.publish).toHaveBeenCalledWith(
        'heartbeat.status',
        expect.objectContaining({
          modules: expect.objectContaining({
            process: 'healthy',
          }),
        }),
      );

      // The disabled modules should not appear in the status
      const publishCall = (deps.eventBus.publish as ReturnType<typeof vi.fn>).mock.calls.find(
        (call: unknown[]) => call[0] === 'heartbeat.status',
      );
      const payload = publishCall![1] as { modules: Record<string, string> };
      expect(payload.modules).not.toHaveProperty('database');
      expect(payload.modules).not.toHaveProperty('agent');
    });
  });

  describe('daily report', () => {
    it('sends daily report when all checks are healthy', async () => {
      // Configure dailyReportCron for a specific time
      const deps = createMockDeps({ dailyReportCron: '0 9 * * *' });
      const monitor = new HeartbeatMonitor(deps);

      monitor.start();

      // Advance past the scheduled daily report time (up to 24h)
      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000 + 1000);

      // Should have sent a daily report message
      const calls = (deps.sendProactiveMessage as ReturnType<typeof vi.fn>).mock.calls;
      const reportCall = calls.find((call: unknown[]) =>
        typeof call[1] === 'string' && (call[1] as string).toLowerCase().includes('daily health report'),
      );
      expect(reportCall).toBeDefined();

      monitor.stop();
    });

    it('suppresses daily report when a check is not healthy', async () => {
      const deps = createMockDeps({
        dailyReportCron: '0 9 * * *',
        checkDatabase: vi.fn(async () => { throw new Error('db down'); }),
      });
      const monitor = new HeartbeatMonitor(deps);

      // Run checks first to establish non-healthy state
      await monitor.runChecks();

      monitor.start();

      // Advance past the daily report time
      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000 + 1000);

      // The only sendProactiveMessage calls should be the health alert, not a daily report
      const calls = (deps.sendProactiveMessage as ReturnType<typeof vi.fn>).mock.calls;
      const reportCall = calls.find((call: unknown[]) =>
        typeof call[1] === 'string' && (call[1] as string).toLowerCase().includes('daily health report'),
      );
      expect(reportCall).toBeUndefined();

      monitor.stop();
    });
  });

  describe('start/stop', () => {
    it('starts interval that triggers runChecks, stop clears interval', async () => {
      const deps = createMockDeps();
      const monitor = new HeartbeatMonitor(deps);

      monitor.start();

      // Advance timer by one interval (30 seconds)
      await vi.advanceTimersByTimeAsync(30_000);

      expect(deps.eventBus.publish).toHaveBeenCalledWith(
        'heartbeat.status',
        expect.objectContaining({
          modules: expect.any(Object),
        }),
      );

      const callCount = (deps.eventBus.publish as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call: unknown[]) => call[0] === 'heartbeat.status',
      ).length;

      monitor.stop();

      // Advance more time — no additional calls
      await vi.advanceTimersByTimeAsync(60_000);

      const callCountAfterStop = (deps.eventBus.publish as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call: unknown[]) => call[0] === 'heartbeat.status',
      ).length;

      expect(callCountAfterStop).toBe(callCount);
    });
  });
});
