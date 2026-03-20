import { readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type {
  EventBus,
  User,
  IncomingMessage,
  AgentRequest,
  AgentEvent,
  PlatformAdapter,
  PlatformConfig,
  GatewayConfig,
} from '@ccbuddy/core';

/** Minimal transcription interface — satisfied by TranscriptionService from @ccbuddy/core */
export interface Transcriber {
  transcribe(audio: Buffer, mimeType: string): Promise<string>;
}

/** Minimal TTS interface — satisfied by SpeechService from @ccbuddy/core */
export interface Synthesizer {
  synthesize(text: string, voice?: string): Promise<Buffer>;
}
import { chunkMessage } from './chunker.js';
import { shouldRespond } from './activation.js';

export interface StoreMessageParams {
  userId: string;
  sessionId: string;
  platform: string;
  content: string;
  role: 'user' | 'assistant';
  attachments?: string;
}

export interface GatewayDeps {
  eventBus: EventBus;
  findUser: (platform: string, platformId: string) => User | undefined;
  buildSessionId: (userName: string, platform: string, channelId: string) => string;
  executeAgentRequest: (request: AgentRequest) => AsyncGenerator<AgentEvent>;
  assembleContext: (userId: string, sessionId: string) => string;
  storeMessage: (params: StoreMessageParams) => void;
  gatewayConfig: GatewayConfig;
  platformsConfig: PlatformConfig;
  outboundMediaDir?: string;
  transcriptionService?: Transcriber;
  speechService?: Synthesizer;
  voiceConfig?: { enabled: boolean; ttsMaxChars: number };
}

const PLATFORM_CHAR_LIMITS: Record<string, number> = {
  discord: 2000,
  telegram: 4096,
};

const DEFAULT_CHAR_LIMIT = 2000;

export class Gateway {
  private adapters = new Map<string, PlatformAdapter>();

  constructor(private deps: GatewayDeps) {
    // Subscribe to session conflict events for user notification
    deps.eventBus.subscribe('session.conflict', (event) => {
      const adapter = this.adapters.get(event.platform);
      if (adapter) {
        const msg = `Another session is using this directory — your request has been queued and will run when it's free.`;
        adapter.sendText(event.channelId, msg).catch((err) => {
          console.error(`[Gateway] Failed to send conflict notification:`, err);
        });
      }
    });
  }

  registerAdapter(adapter: PlatformAdapter): void {
    this.adapters.set(adapter.platform, adapter);
    adapter.onMessage((msg) => {
      // Return the promise so tests can await it via simulateMessage
      return this.handleIncomingMessage(msg).catch((err) => {
        console.error(`[Gateway] Error handling message on ${adapter.platform}:`, err);
      });
    });
  }

  getAdapter(platform: string): PlatformAdapter | undefined {
    return this.adapters.get(platform);
  }

  async start(): Promise<void> {
    for (const adapter of this.adapters.values()) {
      await adapter.start();
    }
  }

  async stop(): Promise<void> {
    for (const adapter of this.adapters.values()) {
      await adapter.stop();
    }
  }

  private async handleIncomingMessage(msg: IncomingMessage): Promise<void> {
    // 1. Identify user
    const user = this.deps.findUser(msg.platform, msg.platformUserId);
    if (!user) {
      if (this.deps.gatewayConfig.unknown_user_reply) {
        const adapter = this.adapters.get(msg.platform);
        await adapter?.sendText(
          msg.channelId,
          "I don't recognize you. Ask the admin to add you.",
        );
      }
      return;
    }

    // 2. Check activation mode
    if (!shouldRespond(msg, this.deps.platformsConfig)) {
      return;
    }

    console.log(`[Gateway] Incoming: platform=${msg.platform} user=${msg.platformUserId} channel=${msg.channelId}`);

    // 3. Build routing info
    const sessionId = this.deps.buildSessionId(user.name, msg.platform, msg.channelId);

    // 4. Publish incoming event
    await this.deps.eventBus.publish('message.incoming', {
      userId: user.name,
      sessionId,
      channelId: msg.channelId,
      platform: msg.platform,
      text: msg.text,
      attachments: msg.attachments,
      isMention: msg.isMention,
      replyToMessageId: msg.replyToMessageId,
      timestamp: Date.now(),
    });

    // 5. Store user message (with attachment metadata if present)
    const attachmentMeta = msg.attachments.length > 0
      ? JSON.stringify(msg.attachments.map(a => ({
          type: a.type,
          mimeType: a.mimeType,
          filename: a.filename,
          bytes: a.data.byteLength,
        })))
      : undefined;

    this.deps.storeMessage({
      userId: user.name,
      sessionId,
      platform: msg.platform,
      content: msg.text,
      role: 'user',
      attachments: attachmentMeta,
    });

    // 6. Assemble memory context
    const memoryContext = this.deps.assembleContext(user.name, sessionId);

    // 7. Build agent request
    const request: AgentRequest = {
      prompt: msg.text,
      userId: user.name,
      sessionId,
      channelId: msg.channelId,
      platform: msg.platform,
      memoryContext,
      attachments: msg.attachments.length > 0 ? msg.attachments : undefined,
      // UserConfig only allows 'admin' | 'chat' roles; 'system' is internal-only
      permissionLevel: user.role === 'admin' ? 'admin' : 'chat',
    };

    // 7b. Transcribe voice attachments
    let voiceInput = false;
    if (this.deps.transcriptionService && msg.attachments.some(a => a.type === 'voice')) {
      for (const att of msg.attachments) {
        if (att.type === 'voice' && !att.transcript) {
          try {
            att.transcript = await this.deps.transcriptionService.transcribe(att.data, att.mimeType);
          } catch (err) {
            console.error('[Gateway] Transcription failed:', (err as Error).message);
          }
        }
      }

      const transcripts = msg.attachments
        .filter(a => a.type === 'voice' && a.transcript)
        .map(a => a.transcript!);
      if (transcripts.length > 0) {
        const transcriptText = transcripts.join(' ');
        request.prompt = msg.text
          ? `${msg.text}\n\n[Voice message] ${transcriptText}`
          : `[Voice message] ${transcriptText}`;
        voiceInput = true;
      }
    }

    // 8. Execute and route response
    await this.executeAndRoute(request, msg, voiceInput);
  }

  private async executeAndRoute(request: AgentRequest, msg: IncomingMessage, voiceInput = false): Promise<void> {
    const adapter = this.adapters.get(msg.platform);
    if (!adapter) return;

    // Snapshot outbound dir before execution so we only deliver files produced by THIS request
    const preExistingFiles = this.snapshotOutboundDir();

    await adapter.setTypingIndicator(msg.channelId, true);

    try {
      for await (const event of this.deps.executeAgentRequest(request)) {
        switch (event.type) {
          case 'complete': {
            this.deps.storeMessage({
              userId: request.userId,
              sessionId: request.sessionId,
              platform: request.platform,
              content: event.response,
              role: 'assistant',
            });

            await this.deps.eventBus.publish('message.outgoing', {
              userId: request.userId,
              sessionId: request.sessionId,
              channelId: request.channelId,
              platform: request.platform,
              text: event.response,
            });

            // Voice mirror logic
            if (voiceInput && this.deps.speechService && adapter.sendVoice) {
              const maxChars = this.deps.voiceConfig?.ttsMaxChars ?? 500;
              if (event.response.length <= maxChars) {
                try {
                  const audio = await this.deps.speechService.synthesize(event.response);
                  await adapter.sendVoice(msg.channelId, audio);
                } catch (err) {
                  console.error('[Gateway] TTS failed, falling back to text:', (err as Error).message);
                  const limit = PLATFORM_CHAR_LIMITS[msg.platform] ?? DEFAULT_CHAR_LIMIT;
                  const chunks = chunkMessage(event.response, limit);
                  for (const chunk of chunks) await adapter.sendText(msg.channelId, chunk);
                }
              } else {
                const voicePart = event.response.slice(0, maxChars);
                const textPart = event.response.slice(maxChars);
                try {
                  const audio = await this.deps.speechService.synthesize(voicePart);
                  await adapter.sendVoice(msg.channelId, audio);
                } catch (err) {
                  console.error('[Gateway] TTS failed:', (err as Error).message);
                }
                const limit = PLATFORM_CHAR_LIMITS[msg.platform] ?? DEFAULT_CHAR_LIMIT;
                const chunks = chunkMessage(textPart, limit);
                for (const chunk of chunks) await adapter.sendText(msg.channelId, chunk);
              }
            } else {
              const limit = PLATFORM_CHAR_LIMITS[msg.platform] ?? DEFAULT_CHAR_LIMIT;
              const chunks = chunkMessage(event.response, limit);
              for (const chunk of chunks) await adapter.sendText(msg.channelId, chunk);
            }

            // Deliver any outbound media files (written by skills to data/outbound/)
            await this.deliverOutboundMedia(adapter, msg.channelId, preExistingFiles);
            break;
          }
          case 'media': {
            for (const item of event.media) {
              if (item.mimeType.startsWith('image/')) {
                await adapter.sendImage(msg.channelId, item.data, item.filename);
              } else {
                await adapter.sendFile(msg.channelId, item.data, item.filename ?? 'file');
              }
            }
            break;
          }
          case 'error':
            await adapter.sendText(
              msg.channelId,
              `Sorry, something went wrong: ${event.error}`,
            );
            break;
          // text and tool_use progress events are published by AgentService directly
        }
      }
    } catch {
      await adapter.sendText(
        msg.channelId,
        'Sorry, something went wrong processing your message.',
      );
    } finally {
      await adapter.setTypingIndicator(msg.channelId, false);
    }
  }

  private snapshotOutboundDir(): Set<string> {
    const dir = this.deps.outboundMediaDir;
    if (!dir) return new Set();
    try {
      return new Set(readdirSync(dir));
    } catch {
      return new Set();
    }
  }

  private async deliverOutboundMedia(adapter: PlatformAdapter, channelId: string, preExisting: Set<string>): Promise<void> {
    const dir = this.deps.outboundMediaDir;
    if (!dir) return;

    let files: string[];
    try {
      files = readdirSync(dir).filter(f => !f.startsWith('.') && !preExisting.has(f));
    } catch {
      return; // dir doesn't exist yet — no media to send
    }

    for (const file of files) {
      const filePath = join(dir, file);
      try {
        const data = readFileSync(filePath);
        const isImage = /\.(jpg|jpeg|png|gif|webp)$/i.test(file);
        if (isImage) {
          await adapter.sendImage(channelId, data, file);
        } else {
          await adapter.sendFile(channelId, data, file);
        }
        unlinkSync(filePath); // clean up after delivery
      } catch (err) {
        console.warn(`[Gateway] Failed to deliver outbound media ${file}:`, (err as Error).message);
      }
    }
  }
}
