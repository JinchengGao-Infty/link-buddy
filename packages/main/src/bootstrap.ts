import { join, dirname } from 'node:path';
import { writeFileSync, renameSync } from 'node:fs';
import { loadConfig, createEventBus, UserManager, TranscriptionService, SpeechService } from '@ccbuddy/core';
import { AgentService, CliBackend } from '@ccbuddy/agent';
import {
  MemoryDatabase,
  MessageStore,
  SummaryStore,
  ProfileStore,
  ContextAssembler,
  RetrievalTools,
  ConsolidationService,
  BackupService,
} from '@ccbuddy/memory';
import { SkillRegistry, MCP_SERVER_PATH } from '@ccbuddy/skills';
import { Gateway } from '@ccbuddy/gateway';
import { TelegramAdapter } from '@ccbuddy/platform-telegram';
import { ShutdownHandler } from '@ccbuddy/orchestrator';
import { SchedulerService } from '@ccbuddy/scheduler';
import { chunkMessage } from '@ccbuddy/gateway';

export interface BootstrapResult {
  stop: () => Promise<void>;
}

export async function bootstrap(configDir?: string): Promise<BootstrapResult> {
  // 1. Load config
  const resolvedConfigDir = configDir ?? join(process.cwd(), 'config');
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
      system: config.agent.rate_limits.system,
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

  // 6b. Create consolidation and backup services
  const summarize = async (text: string): Promise<string> => {
    const sessionId = `consolidation:${Date.now()}`;
    const request: import('@ccbuddy/core').AgentRequest = {
      prompt: text,
      userId: 'system',
      sessionId,
      channelId: 'internal',
      platform: 'system',
      permissionLevel: 'system',
      systemPrompt: 'You are a summarization engine. Summarize the following conversation preserving key facts, decisions, user preferences, and important context. Be concise but thorough. Output only the summary, no preamble.',
    };

    const generator = agentService.handleRequest(request);
    let result = '';
    for await (const event of generator) {
      if (event.type === 'complete') {
        result = event.response;
        break;
      }
      if (event.type === 'error') {
        throw new Error(`Summarization failed: ${event.error}`);
      }
    }
    return result;
  };

  const consolidationService = new ConsolidationService({
    messageStore,
    summaryStore,
    database,
    config: config.memory,
    summarize,
  });

  const backupService = new BackupService({
    database,
    config: config.memory,
    eventBus,
  });

  // 7. Create SkillRegistry and register retrieval tools
  const registryPath = join(dirname(config.skills.generated_dir), 'registry.yaml');
  const skillRegistry = new SkillRegistry(registryPath);
  await skillRegistry.load();

  for (const tool of retrievalTools.getToolDefinitions()) {
    skillRegistry.registerExternalTool(tool);
  }

  // Build skill MCP server spec
  const skillMcpServerPath = config.skills.mcp_server_path ?? MCP_SERVER_PATH;
  const registryDir = dirname(config.skills.generated_dir); // parent dir (e.g., './skills')
  const skillMcpServer = {
    name: 'ccbuddy-skills',
    command: 'node',
    args: [
      skillMcpServerPath,
      '--registry', registryPath,
      '--skills-dir', registryDir,
      ...(config.skills.require_admin_approval_for_elevated ? [] : ['--no-approval']),
      ...(config.skills.auto_git_commit ? [] : ['--no-git-commit']),
      '--memory-db', config.memory.db_path,
      '--heartbeat-status-file', join(config.data_dir, 'heartbeat-status.json'),
    ],
  };

  // 7b. Wire Apple Calendar if enabled
  if (config.apple.enabled) {
    const projectRoot = dirname(resolvedConfigDir);
    const helperPath = config.apple.helper_path
      ?? join(projectRoot, 'swift-helper', '.build', 'release', 'ccbuddy-helper');
    skillMcpServer.args.push('--apple-helper', helperPath);
  }

  // Build Memory Palace MCP server spec (SSE transport)
  const memoryPalaceMcpServer = {
    name: 'memory-palace',
    type: 'sse' as const,
    url: config.memory.memory_palace?.sse_url ?? 'http://localhost:8765',
    headers: config.memory.memory_palace?.api_key
      ? { 'X-MCP-API-Key': config.memory.memory_palace.api_key }
      : undefined,
  };

  const mcpServers = [skillMcpServer, memoryPalaceMcpServer];

  const skillNudge = 'You have access to reusable skills (prefixed skill_) and can create new ones with create_skill. When you solve a novel problem that could be reusable, consider creating a skill for it.\n\nFor image generation requests, use the skill_generate_image tool directly with a descriptive prompt. Do not deliberate — just call the tool.';

  // 7c. Voice services (optional)
  let transcriptionService: TranscriptionService | undefined;
  let speechService: SpeechService | undefined;
  if (config.media.voice_enabled) {
    const openaiKey = process.env.OPENAI_API_KEY;
    if (!openaiKey) {
      throw new Error('voice_enabled is true but OPENAI_API_KEY is not set');
    }
    transcriptionService = new TranscriptionService(openaiKey);
    speechService = new SpeechService(openaiKey);
  }

  // 8. Create Gateway with injected dependencies
  const gateway = new Gateway({
    eventBus,
    findUser: (platform, platformId) => userManager.findByPlatformId(platform, platformId),
    buildSessionId: (userName, platform, channelId) =>
      userManager.buildSessionId(userName, platform, channelId),
    executeAgentRequest: (request) => agentService.handleRequest({
      ...request,
      mcpServers,
      systemPrompt: [request.systemPrompt, skillNudge].filter(Boolean).join('\n\n'),
    }),
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
        attachments: params.attachments,
      });
    },
    onCommand: async (command, userId, sessionId) => {
      if (command === '/compact') {
        const stats = await consolidationService.consolidate(userId);
        const parts: string[] = ['Context compacted.'];
        if (stats.messagesChunked > 0) parts.push(`${stats.messagesChunked} messages summarized`);
        if (stats.leafNodesCreated > 0) parts.push(`${stats.leafNodesCreated} summary nodes created`);
        if (stats.condensedNodesCreated > 0) parts.push(`${stats.condensedNodesCreated} condensed`);
        return parts.join(' ');
      }
      if (command === '/new') {
        // Consolidate first to preserve context as summaries
        await consolidationService.consolidate(userId);
        // Clear session messages so fresh tail is empty
        const deleted = messageStore.deleteBySession(userId, sessionId);
        return `New conversation started. (${deleted} messages archived)`;
      }
      return null;
    },
    gatewayConfig: config.gateway,
    platformsConfig: config.platforms,
    outboundMediaDir: join(config.data_dir, 'outbound'),
    transcriptionService,
    speechService,
    voiceConfig: { enabled: config.media.voice_enabled, ttsMaxChars: config.media.tts_max_chars },
  });

  // 9. Create and register platform adapters based on config
  if (config.platforms.telegram?.enabled && config.platforms.telegram.token) {
    const telegramAdapter = new TelegramAdapter({ token: config.platforms.telegram.token, mediaConfig: config.media });
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

  // 12. Swap in SDK backend if configured (moved before gateway.start() since
  //     we don't use Discord — the original delay was to avoid discord.js side effects)
  if (config.agent.backend === 'sdk') {
    const { SdkBackend } = await import('@ccbuddy/agent');
    agentService.setBackend(new SdkBackend({ skipPermissions: config.agent.admin_skip_permissions }));
  }

  // 13. Start gateway (connects Telegram — note: bot.start() never resolves, it runs polling loop)
  gateway.start().catch((err: Error) => {
    console.error('[Bootstrap] Gateway start error:', err.message);
  });

  // 14. Create proactive sender closure
  const sendProactiveMessage = async (target: { platform: string; channel: string }, text: string) => {
    const adapter = gateway.getAdapter(target.platform);
    if (!adapter) {
      throw new Error(`[Scheduler] No adapter for platform '${target.platform}'`);
    }
    const limit = target.platform === 'telegram' ? 4096 : 2000;
    const chunks = chunkMessage(text, limit);
    for (const chunk of chunks) {
      await adapter.sendText(target.channel, chunk);
    }
    await eventBus.publish('message.outgoing', {
      userId: 'system',
      sessionId: 'scheduler',
      channelId: target.channel,
      platform: target.platform,
      text,
    });
  };

  // 15. Create and start scheduler
  const internalJobs = new Map<string, () => Promise<void>>([
    ['memory_consolidation', async () => {
      const results = await consolidationService.runFullConsolidation();
      for (const [userId, stats] of results) {
        await eventBus.publish('consolidation.complete', stats);
      }
    }],
    ['memory_backup', () => backupService.backup()],
  ]);

  const schedulerService = new SchedulerService({
    config,
    eventBus,
    executeAgentRequest: (request) => agentService.handleRequest({
      ...request,
      mcpServers,
      systemPrompt: [request.systemPrompt, skillNudge].filter(Boolean).join('\n\n'),
    }),
    sendProactiveMessage,
    runSkill: undefined, // skill-type jobs use the agent prompt path; direct skill execution deferred
    assembleContext: (userId, sessionId) => {
      const context = contextAssembler.assemble(userId, sessionId);
      return contextAssembler.formatAsPrompt(context);
    },
    checkDatabase: async () => {
      // Lightweight DB health check — try to read a non-existent row
      messageStore.getById(0);
      return true;
    },
    checkAgent: async () => {
      const start = Date.now();
      const { execFile } = await import('node:child_process');
      return new Promise<{ reachable: boolean; durationMs: number }>((resolve) => {
        execFile('claude', ['--version'], { timeout: 10_000 }, (err) => {
          resolve({ reachable: !err, durationMs: Date.now() - start });
        });
      });
    },
    internalJobs,
  });

  shutdownHandler.register('scheduler', async () => {
    await schedulerService.stop();
  });

  // Heartbeat status file — atomic write for MCP server reads
  const heartbeatStatusPath = join(config.data_dir, 'heartbeat-status.json');
  eventBus.subscribe('heartbeat.status', (data: unknown) => {
    const tmpPath = heartbeatStatusPath + '.tmp';
    try {
      writeFileSync(tmpPath, JSON.stringify(data), 'utf8');
      renameSync(tmpPath, heartbeatStatusPath);
    } catch {
      // Non-fatal — MCP server will report "no data"
    }
  });

  await schedulerService.start();

  return {
    stop: async () => {
      clearInterval(tickInterval);
      await shutdownHandler.execute();
    },
  };
}
