import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { bootstrap } from '../bootstrap.js';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockLoadConfig = vi.fn();
const mockCreateEventBus = vi.fn();
const mockUserManager = vi.fn();

vi.mock('@ccbuddy/core', () => ({
  loadConfig: (...args: unknown[]) => mockLoadConfig(...args),
  createEventBus: (...args: unknown[]) => mockCreateEventBus(...args),
  UserManager: function (this: unknown, ...args: unknown[]) {
    return mockUserManager(...args);
  },
}));

const mockSdkBackend = vi.fn();
const mockCliBackend = vi.fn();
const mockAgentService = vi.fn();

vi.mock('@ccbuddy/agent', () => ({
  SdkBackend: function (this: unknown, ...args: unknown[]) {
    return mockSdkBackend(...args);
  },
  CliBackend: function (this: unknown, ...args: unknown[]) {
    return mockCliBackend(...args);
  },
  AgentService: function (this: unknown, ...args: unknown[]) {
    return mockAgentService(...args);
  },
}));

const mockMemoryDatabase = vi.fn();
const mockMessageStore = vi.fn();
const mockSummaryStore = vi.fn();
const mockProfileStore = vi.fn();
const mockContextAssembler = vi.fn();
const mockRetrievalTools = vi.fn();
const mockConsolidationService = vi.fn();
const mockBackupService = vi.fn();

vi.mock('@ccbuddy/memory', () => ({
  MemoryDatabase: function (this: unknown, ...args: unknown[]) {
    return mockMemoryDatabase(...args);
  },
  MessageStore: function (this: unknown, ...args: unknown[]) {
    return mockMessageStore(...args);
  },
  SummaryStore: function (this: unknown, ...args: unknown[]) {
    return mockSummaryStore(...args);
  },
  ProfileStore: function (this: unknown, ...args: unknown[]) {
    return mockProfileStore(...args);
  },
  ContextAssembler: function (this: unknown, ...args: unknown[]) {
    return mockContextAssembler(...args);
  },
  RetrievalTools: function (this: unknown, ...args: unknown[]) {
    return mockRetrievalTools(...args);
  },
  ConsolidationService: function (this: unknown, ...args: unknown[]) {
    return mockConsolidationService(...args);
  },
  BackupService: function (this: unknown, ...args: unknown[]) {
    return mockBackupService(...args);
  },
}));

const mockSkillRegistry = vi.fn();

vi.mock('@ccbuddy/skills', () => ({
  SkillRegistry: function (this: unknown, ...args: unknown[]) {
    return mockSkillRegistry(...args);
  },
  MCP_SERVER_PATH: '/mock/mcp-server.js',
}));

const mockGateway = vi.fn();

const mockTelegramAdapter = vi.fn();

vi.mock('@ccbuddy/platform-telegram', () => ({
  TelegramAdapter: function (this: unknown, ...args: unknown[]) {
    return mockTelegramAdapter(...args);
  },
}));

const mockShutdownHandler = vi.fn();

vi.mock('@ccbuddy/orchestrator', () => ({
  ShutdownHandler: function (this: unknown, ...args: unknown[]) {
    return mockShutdownHandler(...args);
  },
}));

const mockSchedulerService = vi.fn();

vi.mock('@ccbuddy/scheduler', () => ({
  SchedulerService: function (this: unknown, ...args: unknown[]) {
    return mockSchedulerService(...args);
  },
}));

vi.mock('@ccbuddy/gateway', async (importOriginal) => {
  return {
    Gateway: function (this: unknown, ...args: unknown[]) {
      return mockGateway(...args);
    },
    chunkMessage: (text: string) => [text],
  };
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    agent: {
      backend: 'sdk',
      max_concurrent_sessions: 3,
      session_timeout_minutes: 30,
      queue_max_depth: 10,
      queue_timeout_seconds: 120,
      rate_limits: { admin: 30, chat: 10, system: 20 },
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
      message_retention_days: 30,
    },
    gateway: {
      unknown_user_reply: true,
    },
    platforms: {
      telegram: { enabled: true, token: 'telegram-token-456' },
    },
    data_dir: './data',
    skills: {
      generated_dir: './skills/generated',
      require_admin_approval_for_elevated: true,
      auto_git_commit: true,
    },
    scheduler: {
      timezone: 'UTC',
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
    },
    apple: {
      enabled: false,
    },
    users: {
      alice: { name: 'alice', role: 'admin', discord_id: 'discord-alice' },
    },
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('bootstrap', () => {
  let fakeConfig: ReturnType<typeof makeConfig>;
  let fakeEventBus: { publish: ReturnType<typeof vi.fn>; subscribe: ReturnType<typeof vi.fn> };
  let fakeUserManagerInstance: {
    findByPlatformId: ReturnType<typeof vi.fn>;
    buildSessionId: ReturnType<typeof vi.fn>;
  };
  let fakeSdkBackendInstance: object;
  let fakeAgentServiceInstance: {
    handleRequest: ReturnType<typeof vi.fn>;
    tick: ReturnType<typeof vi.fn>;
    setBackend: ReturnType<typeof vi.fn>;
  };
  let fakeDatabaseInstance: {
    init: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  };
  let fakeMessageStoreInstance: { add: ReturnType<typeof vi.fn>; getById: ReturnType<typeof vi.fn> };
  let fakeSummaryStoreInstance: object;
  let fakeProfileStoreInstance: object;
  let fakeContextAssemblerInstance: {
    assemble: ReturnType<typeof vi.fn>;
    formatAsPrompt: ReturnType<typeof vi.fn>;
  };
  let fakeRetrievalToolsInstance: { getToolDefinitions: ReturnType<typeof vi.fn> };
  let fakeSkillRegistryInstance: {
    load: ReturnType<typeof vi.fn>;
    registerExternalTool: ReturnType<typeof vi.fn>;
  };
  let fakeGatewayInstance: {
    registerAdapter: ReturnType<typeof vi.fn>;
    getAdapter: ReturnType<typeof vi.fn>;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  };
  let fakeTelegramAdapterInstance: object;
  let fakeShutdownHandlerInstance: {
    register: ReturnType<typeof vi.fn>;
    execute: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.useFakeTimers();

    fakeConfig = makeConfig();
    fakeEventBus = { publish: vi.fn(), subscribe: vi.fn() };
    fakeUserManagerInstance = {
      findByPlatformId: vi.fn(),
      buildSessionId: vi.fn().mockReturnValue('alice-discord-ch1'),
    };
    fakeSdkBackendInstance = {};
    fakeAgentServiceInstance = {
      handleRequest: vi.fn().mockReturnValue((async function* () {})()),
      tick: vi.fn(),
      setBackend: vi.fn(),
    };
    fakeDatabaseInstance = {
      init: vi.fn(),
      close: vi.fn(),
    };
    fakeMessageStoreInstance = { add: vi.fn(), getById: vi.fn() };
    fakeSummaryStoreInstance = {};
    fakeProfileStoreInstance = {};
    fakeContextAssemblerInstance = {
      assemble: vi.fn().mockReturnValue({ profile: '', messages: [], summaries: [], totalTokens: 0, needsCompaction: false }),
      formatAsPrompt: vi.fn().mockReturnValue(''),
    };
    fakeRetrievalToolsInstance = {
      getToolDefinitions: vi.fn().mockReturnValue([
        { name: 'memory_grep', description: 'grep', inputSchema: { type: 'object', properties: {}, required: [] } },
        { name: 'memory_describe', description: 'describe', inputSchema: { type: 'object', properties: {}, required: [] } },
        { name: 'memory_expand', description: 'expand', inputSchema: { type: 'object', properties: {}, required: [] } },
      ]),
    };
    fakeSkillRegistryInstance = {
      load: vi.fn().mockResolvedValue(undefined),
      registerExternalTool: vi.fn(),
    };
    fakeGatewayInstance = {
      registerAdapter: vi.fn(),
      getAdapter: vi.fn(),
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    fakeTelegramAdapterInstance = {};
    fakeShutdownHandlerInstance = {
      register: vi.fn(),
      execute: vi.fn().mockResolvedValue(undefined),
    };

    mockLoadConfig.mockReturnValue(fakeConfig);
    mockCreateEventBus.mockReturnValue(fakeEventBus);
    mockUserManager.mockReturnValue(fakeUserManagerInstance);
    mockSdkBackend.mockReturnValue(fakeSdkBackendInstance);
    mockCliBackend.mockReturnValue({});
    mockAgentService.mockReturnValue(fakeAgentServiceInstance);
    mockMemoryDatabase.mockReturnValue(fakeDatabaseInstance);
    mockMessageStore.mockReturnValue(fakeMessageStoreInstance);
    mockSummaryStore.mockReturnValue(fakeSummaryStoreInstance);
    mockProfileStore.mockReturnValue(fakeProfileStoreInstance);
    mockContextAssembler.mockReturnValue(fakeContextAssemblerInstance);
    mockRetrievalTools.mockReturnValue(fakeRetrievalToolsInstance);
    mockConsolidationService.mockReturnValue({
      consolidate: vi.fn(),
      runFullConsolidation: vi.fn().mockResolvedValue(new Map()),
    });
    mockBackupService.mockReturnValue({
      backup: vi.fn().mockResolvedValue(undefined),
      rotateBackups: vi.fn().mockResolvedValue(undefined),
    });
    mockSkillRegistry.mockReturnValue(fakeSkillRegistryInstance);
    mockGateway.mockReturnValue(fakeGatewayInstance);
    mockTelegramAdapter.mockReturnValue(fakeTelegramAdapterInstance);
    mockShutdownHandler.mockReturnValue(fakeShutdownHandlerInstance);
    mockSchedulerService.mockReturnValue({
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('calls loadConfig with the provided configDir', async () => {
    await bootstrap('/etc/ccbuddy');
    expect(mockLoadConfig).toHaveBeenCalledWith('/etc/ccbuddy');
  });

  it('creates SdkBackend with skipPermissions from config', async () => {
    await bootstrap('/config');
    expect(mockSdkBackend).toHaveBeenCalledWith({ skipPermissions: true });
  });

  it('creates CliBackend when backend is cli', async () => {
    const cliConfig = makeConfig({ agent: { ...makeConfig().agent, backend: 'cli' } });
    mockLoadConfig.mockReturnValue(cliConfig);
    await bootstrap('/config');
    expect(mockCliBackend).toHaveBeenCalled();
    expect(mockSdkBackend).not.toHaveBeenCalled();
  });

  it('calls MemoryDatabase.init()', async () => {
    await bootstrap('/config');
    expect(fakeDatabaseInstance.init).toHaveBeenCalled();
  });

  it('loads the SkillRegistry', async () => {
    await bootstrap('/config');
    expect(fakeSkillRegistryInstance.load).toHaveBeenCalled();
  });

  it('registers retrieval tools with SkillRegistry', async () => {
    await bootstrap('/config');
    expect(fakeSkillRegistryInstance.registerExternalTool).toHaveBeenCalledTimes(3);
    const toolNames = (fakeSkillRegistryInstance.registerExternalTool as ReturnType<typeof vi.fn>).mock.calls.map(
      (call) => (call[0] as { name: string }).name,
    );
    expect(toolNames).toContain('memory_grep');
    expect(toolNames).toContain('memory_describe');
    expect(toolNames).toContain('memory_expand');
  });

  it('creates TelegramAdapter with the telegram token', async () => {
    await bootstrap('/config');
    expect(mockTelegramAdapter).toHaveBeenCalledWith(expect.objectContaining({ token: 'telegram-token-456' }));
  });

  it('calls Gateway.registerAdapter once (telegram)', async () => {
    await bootstrap('/config');
    expect(fakeGatewayInstance.registerAdapter).toHaveBeenCalledTimes(1);
    expect(fakeGatewayInstance.registerAdapter).toHaveBeenCalledWith(fakeTelegramAdapterInstance);
  });

  it('calls Gateway.start()', async () => {
    await bootstrap('/config');
    expect(fakeGatewayInstance.start).toHaveBeenCalled();
  });

  it('does not create Telegram adapter when token is missing', async () => {
    const cfg = makeConfig();
    (cfg.platforms as Record<string, unknown>).telegram = { enabled: true };
    mockLoadConfig.mockReturnValue(cfg);
    await bootstrap('/config');
    expect(mockTelegramAdapter).not.toHaveBeenCalled();
  });

  it('fires agentService.tick() on the 60s interval', async () => {
    await bootstrap('/config');
    expect(fakeAgentServiceInstance.tick).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(fakeAgentServiceInstance.tick).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    expect(fakeAgentServiceInstance.tick).toHaveBeenCalledTimes(2);
  });

  it('stop() clears the tick interval and executes shutdown handler', async () => {
    const { stop } = await bootstrap('/config');
    vi.advanceTimersByTime(60_000);
    expect(fakeAgentServiceInstance.tick).toHaveBeenCalledTimes(1);

    await stop();

    // Interval should be cleared — no more ticks
    vi.advanceTimersByTime(60_000);
    expect(fakeAgentServiceInstance.tick).toHaveBeenCalledTimes(1);

    expect(fakeShutdownHandlerInstance.execute).toHaveBeenCalled();
  });

  it('registers shutdown handlers for gateway and database', async () => {
    await bootstrap('/config');
    const registerCalls = (fakeShutdownHandlerInstance.register as ReturnType<typeof vi.fn>).mock.calls;
    const names = registerCalls.map((c) => c[0] as string);
    expect(names).toContain('gateway');
    expect(names).toContain('database');
  });

  it('shutdown handler for database calls database.close()', async () => {
    await bootstrap('/config');
    const registerCalls = (fakeShutdownHandlerInstance.register as ReturnType<typeof vi.fn>).mock.calls;
    const dbEntry = registerCalls.find((c) => c[0] === 'database');
    expect(dbEntry).toBeDefined();
    const callback = dbEntry![1] as () => Promise<void>;
    await callback();
    expect(fakeDatabaseInstance.close).toHaveBeenCalled();
  });

  it('shutdown handler for gateway calls gateway.stop()', async () => {
    await bootstrap('/config');
    const registerCalls = (fakeShutdownHandlerInstance.register as ReturnType<typeof vi.fn>).mock.calls;
    const gwEntry = registerCalls.find((c) => c[0] === 'gateway');
    expect(gwEntry).toBeDefined();
    const callback = gwEntry![1] as () => Promise<void>;
    await callback();
    expect(fakeGatewayInstance.stop).toHaveBeenCalled();
  });

  it('defaults configDir to process.cwd() when not provided', async () => {
    await bootstrap();
    expect(mockLoadConfig).toHaveBeenCalledWith(process.cwd() + '/config');
  });

  it('builds registryPath from dirname of generated_dir', async () => {
    await bootstrap('/config');
    // skills.generated_dir = './skills/generated'
    // dirname('./skills/generated') = 'skills' (node:path strips leading ./)
    // registryPath = 'skills/registry.yaml'
    expect(mockSkillRegistry).toHaveBeenCalledWith('skills/registry.yaml');
  });
});
