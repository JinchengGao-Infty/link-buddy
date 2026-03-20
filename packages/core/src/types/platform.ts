import type { Attachment } from './agent.js';

export interface IncomingMessage {
  platform: string;
  platformUserId: string;
  channelId: string;
  channelType: 'dm' | 'group';
  text: string;
  attachments: Attachment[];
  isMention: boolean;
  replyToMessageId?: string;
  raw: unknown;
}

export interface PlatformAdapter {
  readonly platform: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  onMessage(handler: (msg: IncomingMessage) => void): void;
  sendText(channelId: string, text: string): Promise<void>;
  /** Send text and return a platform message ID (for later editing). */
  sendTextReturningId?(channelId: string, text: string): Promise<string>;
  /** Edit a previously sent message by its platform message ID. */
  editMessageText?(channelId: string, messageId: string, text: string): Promise<void>;
  sendImage(channelId: string, image: Buffer, caption?: string): Promise<void>;
  sendFile(channelId: string, file: Buffer, filename: string): Promise<void>;
  sendVoice?(channelId: string, audio: Buffer): Promise<void>;
  setTypingIndicator(channelId: string, active: boolean): Promise<void>;
}
