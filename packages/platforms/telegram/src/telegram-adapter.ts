import { Bot, InputFile } from 'grammy';
import type { PlatformAdapter, IncomingMessage, Attachment, MediaConfig } from '@ccbuddy/core';
import { fetchAttachment, validateAttachment } from '@ccbuddy/core';

export interface TelegramAdapterConfig {
  token: string;
  mediaConfig: MediaConfig;
}

export class TelegramAdapter implements PlatformAdapter {
  readonly platform = 'telegram';
  private bot: Bot;
  private messageHandler?: (msg: IncomingMessage) => void;

  constructor(private config: TelegramAdapterConfig) {
    this.bot = new Bot(config.token);
    this.bot.catch((err) => {
      console.error('[TelegramAdapter] Bot error (non-fatal):', err.message);
    });
  }

  onMessage(handler: (msg: IncomingMessage) => void): void {
    this.messageHandler = handler;
  }

  async start(): Promise<void> {
    this.bot.on('message:text', (ctx) => {
      if (!this.messageHandler) return;

      const msg = ctx.message;
      const chat = ctx.chat;

      const isDm = chat.type === 'private';
      const botUsername = this.bot.botInfo?.username;
      const isMention = botUsername
        ? msg.text.includes(`@${botUsername}`)
        : false;

      const normalized: IncomingMessage = {
        platform: 'telegram',
        platformUserId: String(msg.from.id),
        channelId: String(chat.id),
        channelType: isDm ? 'dm' : 'group',
        text: msg.text,
        attachments: [],
        isMention: isDm || isMention,
        replyToMessageId: msg.reply_to_message?.message_id
          ? String(msg.reply_to_message.message_id)
          : undefined,
        raw: ctx,
      };

      // Handler may return a Promise (gateway does) — catch defensively
      Promise.resolve(this.messageHandler(normalized)).catch((err) => {
        console.error('[TelegramAdapter] Unhandled error in message handler:', err);
      });
    });

    this.bot.on('message:photo', async (ctx) => {
      if (!this.messageHandler) return;

      const msg = ctx.message;
      const chat = ctx.chat;
      const photo = msg.photo[msg.photo.length - 1];

      await this.downloadAndDispatch({
        fileId: photo.file_id,
        mimeType: 'image/jpeg',
        filename: undefined,
        text: msg.caption ?? '',
        ctx,
        chat,
        msg,
      });
    });

    this.bot.on('message:document', async (ctx) => {
      if (!this.messageHandler) return;

      const msg = ctx.message;
      const chat = ctx.chat;
      const doc = msg.document;

      await this.downloadAndDispatch({
        fileId: doc.file_id,
        mimeType: doc.mime_type ?? 'application/octet-stream',
        filename: doc.file_name ?? undefined,
        text: msg.caption ?? '',
        ctx,
        chat,
        msg,
      });
    });

    this.bot.on('message:voice', async (ctx) => {
      if (!this.messageHandler) return;

      const msg = ctx.message;
      const chat = ctx.chat;
      const voice = msg.voice;

      await this.downloadAndDispatch({
        fileId: voice.file_id,
        mimeType: voice.mime_type ?? 'audio/ogg',
        filename: 'voice.ogg',
        text: '',
        ctx,
        chat,
        msg,
        attachmentTypeOverride: 'voice',
      });
    });

    const startWithRetry = async (retries = 5) => {
      for (let i = 0; i < retries; i++) {
        try {
          await this.bot.start({
            onStart: () => console.log('[TelegramAdapter] Bot polling started'),
            allowed_updates: ['message'],
            drop_pending_updates: true,
          });
          return;
        } catch (err: any) {
          if (err?.error_code === 409 && i < retries - 1) {
            console.log(`[TelegramAdapter] 409 conflict, retrying in ${(i + 1) * 3}s... (${i + 1}/${retries})`);
            await new Promise(r => setTimeout(r, (i + 1) * 3000));
            continue;
          }
          throw err;
        }
      }
    };
    await startWithRetry();
  }

  async stop(): Promise<void> {
    await this.bot.stop();
  }

  async sendText(channelId: string, text: string): Promise<void> {
    await this.bot.api.sendMessage(Number(channelId), text);
  }

  async sendTextReturningId(channelId: string, text: string): Promise<string> {
    const msg = await this.bot.api.sendMessage(Number(channelId), text);
    return String(msg.message_id);
  }

  async editMessageText(channelId: string, messageId: string, text: string): Promise<void> {
    try {
      await this.bot.api.editMessageText(Number(channelId), Number(messageId), text);
    } catch (err) {
      // Telegram returns 400 if text is unchanged — ignore
      if (!(err as any)?.description?.includes('message is not modified')) {
        throw err;
      }
    }
  }

  async sendImage(channelId: string, image: Buffer, caption?: string): Promise<void> {
    await this.bot.api.sendPhoto(
      Number(channelId),
      new InputFile(image, 'image.png'),
      { caption },
    );
  }

  async sendFile(channelId: string, file: Buffer, filename: string): Promise<void> {
    await this.bot.api.sendDocument(
      Number(channelId),
      new InputFile(file, filename),
    );
  }

  async sendVoice(channelId: string, audio: Buffer): Promise<void> {
    await this.bot.api.sendVoice(
      Number(channelId),
      new InputFile(audio, 'voice.ogg'),
    );
  }

  private typingIntervals = new Map<string, ReturnType<typeof setInterval>>();

  async setTypingIndicator(channelId: string, active: boolean): Promise<void> {
    if (active) {
      // Send immediately, then repeat every 4s (Telegram typing expires after 5s)
      const send = () => this.bot.api.sendChatAction(Number(channelId), 'typing').catch(() => {});
      await send();
      if (!this.typingIntervals.has(channelId)) {
        this.typingIntervals.set(channelId, setInterval(send, 4000));
      }
    } else {
      const interval = this.typingIntervals.get(channelId);
      if (interval) {
        clearInterval(interval);
        this.typingIntervals.delete(channelId);
      }
    }
  }

  private async downloadAndDispatch(opts: {
    fileId: string;
    mimeType: string;
    filename: string | undefined;
    text: string;
    ctx: unknown;
    chat: { id: number; type: string };
    msg: { from: { id: number }; reply_to_message?: { message_id: number } | null };
    attachmentTypeOverride?: 'image' | 'file' | 'voice';
  }): Promise<void> {
    const { fileId, mimeType, filename, text, ctx, chat, msg, attachmentTypeOverride } = opts;

    const file = await (ctx as { api: { getFile(id: string): Promise<{ file_path?: string }> } }).api.getFile(fileId);

    if (!file.file_path) {
      console.warn('[TelegramAdapter] No file_path returned for file_id:', fileId);
      return;
    }

    const url = `https://api.telegram.org/file/bot${this.config.token}/${file.file_path}`;

    let data: Buffer;
    try {
      data = await fetchAttachment(url, {
        maxBytes: this.config.mediaConfig.max_file_size_mb * 1024 * 1024,
      });
    } catch (err) {
      console.warn(`[TelegramAdapter] Failed to download attachment: ${(err as Error).message}`);
      return;
    }

    const attachment: Attachment = {
      type: attachmentTypeOverride ?? (mimeType.startsWith('image/') ? 'image' : 'file'),
      mimeType,
      data,
      filename,
    };

    const validation = validateAttachment(attachment, this.config.mediaConfig);
    if (!validation.valid) {
      console.warn(`[TelegramAdapter] Attachment skipped: ${validation.reason}`);
      return;
    }

    const isDm = chat.type === 'private';
    const botUsername = this.bot.botInfo?.username;
    const isMention = botUsername ? text.includes(`@${botUsername}`) : false;

    const normalized: IncomingMessage = {
      platform: 'telegram',
      platformUserId: String(msg.from.id),
      channelId: String(chat.id),
      channelType: isDm ? 'dm' : 'group',
      text,
      attachments: [attachment],
      isMention: isDm || isMention,
      replyToMessageId: msg.reply_to_message?.message_id
        ? String(msg.reply_to_message.message_id)
        : undefined,
      raw: ctx,
    };

    Promise.resolve(this.messageHandler!(normalized)).catch((err) => {
      console.error('[TelegramAdapter] Unhandled error in message handler:', err);
    });
  }
}
