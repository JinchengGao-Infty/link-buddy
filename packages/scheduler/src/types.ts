import type {
  MessageTarget,
  EventBus,
  AgentRequest,
  AgentEvent,
  CCBuddyConfig,
} from '@ccbuddy/core';

export interface BaseJob {
  name: string;
  cron: string;
  enabled: boolean;
  nextRun: number;
  lastRun?: number;
  running: boolean;
  timezone?: string;
}

export interface PromptJob extends BaseJob {
  type: 'prompt';
  payload: string;
  user: string;
  target: MessageTarget;
  permissionLevel: 'admin' | 'system';
}

export interface SkillJob extends BaseJob {
  type: 'skill';
  payload: string;
  user: string;
  target: MessageTarget;
  permissionLevel: 'admin' | 'system';
}

export interface InternalJob extends BaseJob {
  type: 'internal';
}

export type ScheduledJob = PromptJob | SkillJob | InternalJob;

export interface TriggerResult {
  source: 'cron' | 'heartbeat' | 'webhook';
  name: string;
  response: string;
  target: MessageTarget;
  timestamp: number;
}

export interface HealthCheckResult {
  name: string;
  status: 'healthy' | 'degraded' | 'down';
  message?: string;
  durationMs: number;
}

export interface SchedulerDeps {
  config: CCBuddyConfig;
  eventBus: EventBus;
  executeAgentRequest: (request: AgentRequest) => AsyncGenerator<AgentEvent>;
  sendProactiveMessage: (target: MessageTarget, text: string) => Promise<void>;
  runSkill?: (name: string, input: Record<string, unknown>) => Promise<string>;
  checkDatabase: () => Promise<boolean>;
  checkAgent: () => Promise<{ reachable: boolean; durationMs: number }>;
  assembleContext: (userId: string, sessionId: string) => string;
  internalJobs?: Map<string, () => Promise<void>>;
}

export type { MessageTarget };
