import { join, dirname } from 'node:path';
import { loadConfig, createEventBus, UserManager } from '@ccbuddy/core';
import { AgentService, CliBackend } from '@ccbuddy/agent';
import {
  MemoryDatabase,
  MessageStore,
  SummaryStore,
  ProfileStore,
  ContextAssembler,
  RetrievalTools,
} from '@ccbuddy/memory';
import { SkillRegistry } from '@ccbuddy/skills';
import { Gateway } from '@ccbuddy/gateway';
import { DiscordAdapter } from '@ccbuddy/platform-discord';
import { TelegramAdapter } from '@ccbuddy/platform-telegram';
import { ShutdownHandler } from '@ccbuddy/orchestrator';

export interface BootstrapResult {
  stop: () => Promise<void>;
}

export async function bootstrap(configDir?: string): Promise<BootstrapResult> {
  // 1. Load config
  const resolvedConfigDir = configDir ?? process.cwd();
  const config = loadConfig(resolvedConfigDir);

  // 2. Create event bus
  const eventBus = createEventBus();

  // 3. Create UserManager from config users
  const userManager = new UserManager(Object.values(config.users));

  // 4. Create agent backend with CLI (SDK loaded lazily after Discord connects)
  const backend = new CliBackend();

  // 5. Create AgentService
  const agentService = new AgentService({
    backend,
    eventBus,
    maxConcurrent: config.agent.max_concurrent_sessions,
    rateLimits: {
      admin: config.agent.rate_limits.admin,
      chat: config.agent.rate_limits.chat,
    },
    queueMaxDepth: config.agent.queue_max_depth,
    queueTimeoutSeconds: config.agent.queue_timeout_seconds,
    sessionTimeoutMinutes: config.agent.session_timeout_minutes,
    sessionCleanupHours: config.agent.session_cleanup_hours,
  });

  // 6. Create memory stores
  const database = new MemoryDatabase(config.memory.db_path);
  database.init();

  const messageStore = new MessageStore(database);
  const summaryStore = new SummaryStore(database);
  const profileStore = new ProfileStore(database);

  const contextAssembler = new ContextAssembler(messageStore, summaryStore, profileStore, {
    maxContextTokens: config.memory.max_context_tokens,
    freshTailCount: config.memory.fresh_tail_count,
    contextThreshold: config.memory.context_threshold,
  });

  const retrievalTools = new RetrievalTools(messageStore, summaryStore);

  // 7. Create SkillRegistry and register retrieval tools
  const registryPath = join(dirname(config.skills.generated_dir), 'registry.yaml');
  const skillRegistry = new SkillRegistry(registryPath);
  await skillRegistry.load();

  for (const tool of retrievalTools.getToolDefinitions()) {
    skillRegistry.registerExternalTool(tool);
  }

  // 8. Create Gateway with injected dependencies
  const gateway = new Gateway({
    eventBus,
    findUser: (platform, platformId) => userManager.findByPlatformId(platform, platformId),
    buildSessionId: (userName, platform, channelId) =>
      userManager.buildSessionId(userName, platform, channelId),
    executeAgentRequest: (request) => agentService.handleRequest(request),
    assembleContext: (userId, sessionId) => {
      const context = contextAssembler.assemble(userId, sessionId);
      return contextAssembler.formatAsPrompt(context);
    },
    storeMessage: (params) => {
      messageStore.add({
        userId: params.userId,
        sessionId: params.sessionId,
        platform: params.platform,
        content: params.content,
        role: params.role,
      });
    },
    gatewayConfig: config.gateway,
    platformsConfig: config.platforms,
  });

  // 9. Create and register platform adapters based on config
  if (config.platforms.discord?.enabled && config.platforms.discord.token) {
    const discordAdapter = new DiscordAdapter({ token: config.platforms.discord.token });
    gateway.registerAdapter(discordAdapter);
  }

  if (config.platforms.telegram?.enabled && config.platforms.telegram.token) {
    const telegramAdapter = new TelegramAdapter({ token: config.platforms.telegram.token });
    gateway.registerAdapter(telegramAdapter);
  }

  // 10. Set up SessionManager.tick() interval (every 60 seconds)
  const tickInterval = setInterval(() => {
    agentService.tick();
  }, 60_000);

  // 11. Create shutdown handler
  const shutdownHandler = new ShutdownHandler(
    config.agent.graceful_shutdown_timeout_seconds * 1000,
  );

  shutdownHandler.register('gateway', async () => {
    await gateway.stop();
  });

  shutdownHandler.register('database', async () => {
    database.close();
  });

  // 12. Start gateway (connects Discord/Telegram)
  await gateway.start();

  // 13. Swap in SDK backend if configured (must happen AFTER discord.js connects —
  //     the SDK module has side effects that suppress discord.js WebSocket events
  //     if imported before the connection is established)
  if (config.agent.backend === 'sdk') {
    const { SdkBackend } = await import('@ccbuddy/agent');
    agentService.setBackend(new SdkBackend({ skipPermissions: config.agent.admin_skip_permissions }));
  }

  return {
    stop: async () => {
      clearInterval(tickInterval);
      await shutdownHandler.execute();
    },
  };
}
