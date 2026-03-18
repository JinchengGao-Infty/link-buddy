import { Bot, InputFile } from 'grammy';
import type { PlatformAdapter, IncomingMessage } from '@ccbuddy/core';

export interface TelegramAdapterConfig {
  token: string;
}

export class TelegramAdapter implements PlatformAdapter {
  readonly platform = 'telegram';
  private bot: Bot;
  private messageHandler?: (msg: IncomingMessage) => void;

  constructor(private config: TelegramAdapterConfig) {
    this.bot = new Bot(config.token);
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

      this.messageHandler(normalized);
    });

    await this.bot.start();
  }

  async stop(): Promise<void> {
    await this.bot.stop();
  }

  async sendText(channelId: string, text: string): Promise<void> {
    await this.bot.api.sendMessage(Number(channelId), text);
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

  async setTypingIndicator(channelId: string, active: boolean): Promise<void> {
    if (!active) return;
    await this.bot.api.sendChatAction(Number(channelId), 'typing');
  }
}
