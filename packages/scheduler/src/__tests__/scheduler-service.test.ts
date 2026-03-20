import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  AgentEvent,
  AgentRequest,
  EventBus,
  CCBuddyConfig,
} from '@ccbuddy/core';
import type { SchedulerDeps } from '../types.js';

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

import { SchedulerService } from '../scheduler-service.js';

function createMinimalConfig(overrides: Partial<CCBuddyConfig> = {}): CCBuddyConfig {
  return {
    data_dir: './data',
    log_level: 'info',
    agent: {
      backend: 'sdk',
      max_concurrent_sessions: 3,
      session_timeout_minutes: 30,
      queue_max_depth: 10,
      queue_timeout_seconds: 120,
      rate_limits: {
        admin: 30,
        chat: 10,
        system: 20,
      },
      default_working_directory: '~',
      admin_skip_permissions: true,
      session_cleanup_hours: 24,
      pending_input_timeout_minutes: 10,
      graceful_shutdown_timeout_seconds: 30,
    },
    memory: {
      db_path: './data/memory.sqlite',
      max_context_tokens: 100000,
      context_threshold: 0.75,
      fresh_tail_count: 32,
      leaf_chunk_tokens: 20000,
      leaf_target_tokens: 1200,
      condensed_target_tokens: 2000,
      max_expand_tokens: 4000,
      consolidation_cron: '0 3 * * *',
      backup_cron: '0 4 * * *',
      backup_dir: './data/backups',
      max_backups: 7,
      message_retention_days: 90,
    },
    gateway: {
      unknown_user_reply: true,
    },
    platforms: {},
    scheduler: {
      timezone: 'UTC',
      default_target: { platform: 'discord', channel: '999' },
      jobs: {
        briefing: {
          cron: '0 8 * * *',
          prompt: 'Morning briefing',
          user: 'testuser',
        },
      },
    },
    heartbeat: {
      interval_seconds: 60,
      checks: { process: true, database: true, agent: true },
    },
    webhooks: {
      enabled: false,
      port: 18800,
    },
    media: {
      max_file_size_mb: 10,
      allowed_mime_types: ['image/jpeg', 'image/png'],
      voice_enabled: false,
      tts_max_chars: 500,
    },
    image_generation: {
      enabled: false,
    },
    skills: {
      generated_dir: './skills/generated',
      sandbox_enabled: true,
      require_admin_approval_for_elevated: true,
      auto_git_commit: true,
    },
    apple: {
      enabled: false,
    },
    users: {},
    ...overrides,
  };
}

function createMockDeps(overrides: Partial<SchedulerDeps> = {}): SchedulerDeps {
  const completeEvent: AgentEvent = {
    type: 'complete',
    response: 'Done.',
    sessionId: 'test-session',
    userId: 'testuser',
    channelId: '999',
    platform: 'discord',
  };

  const executeAgentRequest = vi.fn(async function* (_req: AgentRequest): AsyncGenerator<AgentEvent> {
    yield completeEvent;
  });

  const sendProactiveMessage = vi.fn(async () => {});
  const runSkill = vi.fn(async () => 'skill-result');
  const assembleContext = vi.fn().mockReturnValue('');
  const checkDatabase = vi.fn(async () => true);
  const checkAgent = vi.fn(async () => ({ reachable: true, durationMs: 50 }));

  const eventBus: EventBus = {
    publish: vi.fn(async () => {}),
    subscribe: vi.fn(() => ({ dispose: vi.fn() })),
  };

  return {
    config: createMinimalConfig(),
    eventBus,
    executeAgentRequest,
    sendProactiveMessage,
    runSkill,
    assembleContext,
    checkDatabase,
    checkAgent,
    ...overrides,
  };
}

describe('SchedulerService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('creates and starts without error', async () => {
    const deps = createMockDeps();
    const service = new SchedulerService(deps);

    await expect(service.start()).resolves.not.toThrow();
  });

  it('registers cron jobs from config', async () => {
    const deps = createMockDeps();
    const service = new SchedulerService(deps);

    await service.start();

    // The CronRunner calls node-cron schedule for each enabled job
    expect(mockSchedule).toHaveBeenCalledWith(
      '0 8 * * *',
      expect.any(Function),
      expect.objectContaining({ timezone: 'UTC' }),
    );
  });

  it('resolves job target from default_target when job has no explicit target', async () => {
    const deps = createMockDeps();
    const service = new SchedulerService(deps);

    await service.start();

    const jobs = service.getJobs();
    expect(jobs.length).toBe(1);
    const job = jobs[0];
    if (job.type === 'internal') throw new Error('Expected a prompt or skill job');
    expect(job.target).toEqual({ platform: 'discord', channel: '999' });
  });

  it('does not start webhook server when webhooks disabled', async () => {
    const deps = createMockDeps();
    const service = new SchedulerService(deps);

    await service.start();

    // Webhooks are disabled in our config, so no HTTP server should be created.
    // We verify indirectly: stop should resolve without issues (no server to close).
    await expect(service.stop()).resolves.not.toThrow();
  });

  it('shuts down cleanly', async () => {
    const deps = createMockDeps();
    const service = new SchedulerService(deps);

    await service.start();
    await expect(service.stop()).resolves.not.toThrow();
  });

  it('maps timezone from job config to ScheduledJob', async () => {
    const config = createMinimalConfig();
    config.scheduler.jobs = {
      briefing: {
        cron: '0 7 * * *',
        prompt: 'Morning briefing',
        user: 'testuser',
        timezone: 'America/Chicago',
      },
    };
    const deps = createMockDeps({ config });
    const service = new SchedulerService(deps);
    await service.start();

    const jobs = service.getJobs();
    expect(jobs[0].timezone).toBe('America/Chicago');

    await service.stop();
  });
});
