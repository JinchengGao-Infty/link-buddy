import { describe, it, expect, vi, beforeEach } from 'vitest';

const textHandlers: Function[] = [];
const mockSendMessage = vi.fn().mockResolvedValue(undefined);
const mockSendPhoto = vi.fn().mockResolvedValue(undefined);
const mockSendDocument = vi.fn().mockResolvedValue(undefined);
const mockSendChatAction = vi.fn().mockResolvedValue(undefined);
const mockBotStart = vi.fn().mockResolvedValue(undefined);
const mockBotStop = vi.fn().mockResolvedValue(undefined);

vi.mock('grammy', () => ({
  Bot: vi.fn().mockImplementation(() => ({
    on: vi.fn().mockImplementation((filter: string, handler: Function) => {
      if (filter === 'message:text') textHandlers.push(handler);
    }),
    start: mockBotStart,
    stop: mockBotStop,
    botInfo: { username: 'CCBuddyBot' },
    api: {
      sendMessage: mockSendMessage,
      sendPhoto: mockSendPhoto,
      sendDocument: mockSendDocument,
      sendChatAction: mockSendChatAction,
    },
  })),
  InputFile: vi.fn().mockImplementation((data: Buffer, filename: string) => ({
    data,
    filename,
  })),
}));

import { TelegramAdapter } from '../telegram-adapter.js';
import type { IncomingMessage } from '@ccbuddy/core';

function fakeTelegramCtx(overrides: Record<string, unknown> = {}) {
  return {
    message: {
      from: { id: 456 },
      text: 'Hi there',
      reply_to_message: null,
      ...((overrides.message as Record<string, unknown>) ?? {}),
    },
    chat: {
      id: 789,
      type: 'group',
      ...((overrides.chat as Record<string, unknown>) ?? {}),
    },
  };
}

describe('TelegramAdapter', () => {
  let adapter: TelegramAdapter;
  let receivedMessages: IncomingMessage[];

  beforeEach(() => {
    vi.clearAllMocks();
    textHandlers.length = 0;
    receivedMessages = [];
    adapter = new TelegramAdapter({ token: 'tg-token' });
    adapter.onMessage((msg) => receivedMessages.push(msg));
  });

  describe('start / stop', () => {
    it('starts the bot on start', async () => {
      await adapter.start();
      expect(mockBotStart).toHaveBeenCalled();
    });

    it('stops the bot on stop', async () => {
      await adapter.start();
      await adapter.stop();
      expect(mockBotStop).toHaveBeenCalled();
    });
  });

  describe('message normalization', () => {
    it('normalizes a group text message', async () => {
      await adapter.start();
      textHandlers[0](fakeTelegramCtx());

      expect(receivedMessages).toHaveLength(1);
      expect(receivedMessages[0]).toEqual(
        expect.objectContaining({
          platform: 'telegram',
          platformUserId: '456',
          channelId: '789',
          channelType: 'group',
          text: 'Hi there',
          isMention: false,
        }),
      );
    });

    it('detects private chat as DM', async () => {
      await adapter.start();
      textHandlers[0](fakeTelegramCtx({ chat: { id: 789, type: 'private' } }));

      expect(receivedMessages[0].channelType).toBe('dm');
      expect(receivedMessages[0].isMention).toBe(true);
    });

    it('detects bot mention in text', async () => {
      await adapter.start();
      textHandlers[0](fakeTelegramCtx({
        message: { from: { id: 456 }, text: 'Hey @CCBuddyBot check this', reply_to_message: null },
      }));

      expect(receivedMessages[0].isMention).toBe(true);
    });

    it('captures reply reference', async () => {
      await adapter.start();
      textHandlers[0](fakeTelegramCtx({
        message: {
          from: { id: 456 },
          text: 'reply',
          reply_to_message: { message_id: 42 },
        },
      }));

      expect(receivedMessages[0].replyToMessageId).toBe('42');
    });
  });

  describe('sending', () => {
    it('sends text message', async () => {
      await adapter.sendText('789', 'Hello');
      expect(mockSendMessage).toHaveBeenCalledWith(789, 'Hello');
    });

    it('sends image with caption', async () => {
      const buf = Buffer.from('png');
      await adapter.sendImage('789', buf, 'Photo');
      expect(mockSendPhoto).toHaveBeenCalledWith(
        789,
        expect.objectContaining({ data: buf }),
        { caption: 'Photo' },
      );
    });

    it('sends file', async () => {
      const buf = Buffer.from('data');
      await adapter.sendFile('789', buf, 'doc.pdf');
      expect(mockSendDocument).toHaveBeenCalledWith(
        789,
        expect.objectContaining({ data: buf }),
      );
    });

    it('sends typing action', async () => {
      await adapter.setTypingIndicator('789', true);
      expect(mockSendChatAction).toHaveBeenCalledWith(789, 'typing');
    });

    it('no-ops for typing indicator false', async () => {
      await adapter.setTypingIndicator('789', false);
      expect(mockSendChatAction).not.toHaveBeenCalled();
    });
  });
});
