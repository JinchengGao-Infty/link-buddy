import { Client, GatewayIntentBits, ChannelType, Partials } from 'discord.js';
import type { Message, SendableChannels } from 'discord.js';
import type { PlatformAdapter, IncomingMessage, Attachment, MediaConfig } from '@ccbuddy/core';
import { fetchAttachment, validateAttachment } from '@ccbuddy/core';

export interface DiscordAdapterConfig {
  token: string;
  mediaConfig: MediaConfig;
}

export class DiscordAdapter implements PlatformAdapter {
  readonly platform = 'discord';
  private client: Client;
  private messageHandler?: (msg: IncomingMessage) => void;

  constructor(private config: DiscordAdapterConfig) {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Channel],
    });
  }

  onMessage(handler: (msg: IncomingMessage) => void): void {
    this.messageHandler = handler;
  }

  async start(): Promise<void> {
    this.client.once('clientReady', () => {
      console.log(`[Discord] Bot ready as ${this.client.user?.tag}`);
    });

    this.client.on('messageCreate', (msg: Message) => {
      if (msg.author.bot) return;
      if (!this.messageHandler) return;
      this.normalizeMessage(msg).then((normalized) => {
        if (normalized) {
          Promise.resolve(this.messageHandler!(normalized)).catch((err) => {
            console.error('[DiscordAdapter] Unhandled error in message handler:', err);
          });
        }
      }).catch((err) => {
        console.error('[DiscordAdapter] Error normalizing message:', err);
      });
    });
    await this.client.login(this.config.token);
  }

  async stop(): Promise<void> {
    this.client.destroy();
  }

  async sendText(channelId: string, text: string): Promise<void> {
    const channel = await this.fetchTextChannel(channelId);
    if (channel) await channel.send(text);
  }

  async sendImage(channelId: string, image: Buffer, caption?: string): Promise<void> {
    const channel = await this.fetchTextChannel(channelId);
    if (channel) {
      await channel.send({
        ...(caption ? { content: caption } : {}),
        files: [{ attachment: image, name: 'image.png' }],
      });
    }
  }

  async sendFile(channelId: string, file: Buffer, filename: string): Promise<void> {
    const channel = await this.fetchTextChannel(channelId);
    if (channel) {
      await channel.send({
        files: [{ attachment: file, name: filename }],
      });
    }
  }

  async sendVoice(channelId: string, audio: Buffer): Promise<void> {
    const channel = await this.fetchTextChannel(channelId);
    if (channel) {
      await channel.send({
        files: [{ attachment: audio, name: 'voice.ogg' }],
      });
    }
  }

  async setTypingIndicator(channelId: string, active: boolean): Promise<void> {
    if (!active) return;
    const channel = await this.fetchTextChannel(channelId);
    if (channel) await channel.sendTyping();
  }

  private async fetchTextChannel(channelId: string): Promise<SendableChannels | null> {
    const channel = await this.client.channels.fetch(channelId);
    if (channel?.isSendable()) return channel;
    return null;
  }

  private async normalizeMessage(msg: Message): Promise<IncomingMessage | null> {
    const isDm = msg.channel?.type === ChannelType.DM;
    const isMention = msg.mentions.has(this.client.user!);

    const attachments: Attachment[] = [];
    for (const [, att] of msg.attachments) {
      try {
        const data = await fetchAttachment(att.url, {
          maxBytes: this.config.mediaConfig.max_file_size_mb * 1024 * 1024,
        });
        const mimeType = att.contentType ?? 'application/octet-stream';
        const attachmentType = mimeType.startsWith('image/') ? 'image'
          : mimeType.startsWith('audio/') ? 'voice'
          : 'file';
        const attachment: Attachment = {
          type: attachmentType,
          mimeType,
          data,
          filename: att.name ?? undefined,
        };
        const validation = validateAttachment(attachment, this.config.mediaConfig);
        if (validation.valid) {
          attachments.push(attachment);
        } else {
          console.warn(`[DiscordAdapter] Attachment skipped: ${validation.reason}`);
        }
      } catch (err) {
        console.warn(`[DiscordAdapter] Failed to download attachment: ${(err as Error).message}`);
      }
    }

    return {
      platform: 'discord',
      platformUserId: msg.author.id,
      channelId: msg.channelId,
      channelType: isDm ? 'dm' : 'group',
      text: msg.content ?? '',
      attachments,
      isMention: isDm || isMention,
      replyToMessageId: msg.reference?.messageId ?? undefined,
      raw: msg,
    };
  }
}
