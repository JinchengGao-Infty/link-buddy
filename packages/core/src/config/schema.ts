export interface AgentConfig {
  backend: 'sdk' | 'cli';
  max_concurrent_sessions: number;
  session_timeout_minutes: number;
  queue_max_depth: number;
  queue_timeout_seconds: number;
  rate_limits: {
    admin: number;
    chat: number;
  };
}

export interface MemoryConfig {
  db_path: string;
  max_context_tokens: number;
  context_threshold: number;
}

export interface PlatformChannelConfig {
  token?: string;
  channel_id?: string;
  guild_id?: string;
  chat_id?: string;
  [key: string]: string | undefined;
}

export interface PlatformConfig {
  discord?: PlatformChannelConfig;
  telegram?: PlatformChannelConfig;
  [key: string]: PlatformChannelConfig | undefined;
}

export interface HeartbeatConfig {
  interval_seconds: number;
}

export interface WebhookHandler {
  path: string;
  secret?: string;
}

export interface WebhooksConfig {
  enabled: boolean;
  port: number;
  handlers?: Record<string, WebhookHandler>;
}

export interface MediaConfig {
  max_file_size_mb: number;
  allowed_mime_types: string[];
}

export interface ImageGenerationConfig {
  enabled: boolean;
  provider?: string;
  model?: string;
}

export interface SkillsConfig {
  directory: string;
  auto_reload: boolean;
}

export interface AppleConfig {
  shortcuts_enabled: boolean;
}

export interface SchedulerConfig {
  timezone: string;
}

export interface UserConfig {
  name: string;
  role: 'admin' | 'chat';
  [key: string]: string | undefined;
}

export interface GatewayConfig {
  host: string;
  port: number;
}

export interface CCBuddyConfig {
  data_dir: string;
  log_level: 'debug' | 'info' | 'warn' | 'error';
  agent: AgentConfig;
  memory: MemoryConfig;
  gateway: GatewayConfig;
  platforms: PlatformConfig;
  scheduler: SchedulerConfig;
  heartbeat: HeartbeatConfig;
  webhooks: WebhooksConfig;
  media: MediaConfig;
  image_generation: ImageGenerationConfig;
  skills: SkillsConfig;
  apple: AppleConfig;
  users: Record<string, UserConfig>;
}

export const DEFAULT_CONFIG: CCBuddyConfig = {
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
    },
  },
  memory: {
    db_path: './data/memory.sqlite',
    max_context_tokens: 100000,
    context_threshold: 0.75,
  },
  gateway: {
    host: '127.0.0.1',
    port: 18900,
  },
  platforms: {},
  scheduler: {
    timezone: 'UTC',
  },
  heartbeat: {
    interval_seconds: 60,
  },
  webhooks: {
    enabled: false,
    port: 18800,
  },
  media: {
    max_file_size_mb: 10,
    allowed_mime_types: ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf'],
  },
  image_generation: {
    enabled: false,
  },
  skills: {
    directory: './skills',
    auto_reload: false,
  },
  apple: {
    shortcuts_enabled: false,
  },
  users: {},
};
