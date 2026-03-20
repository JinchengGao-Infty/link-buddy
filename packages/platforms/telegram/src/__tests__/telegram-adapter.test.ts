import { describe, it, expect, vi, beforeEach } from 'vitest';

const textHandlers: Function[] = [];
const photoHandlers: Function[] = [];
const documentHandlers: Function[] = [];
const voiceHandlers: Function[] = [];
const mockSendMessage = vi.fn().mockResolvedValue(undefined);
const mockSendPhoto = vi.fn().mockResolvedValue(undefined);
const mockSendDocument = vi.fn().mockResolvedValue(undefined);
const mockSendVoice = vi.fn().mockResolvedValue(undefined);
const mockSendChatAction = vi.fn().mockResolvedValue(undefined);
const mockGetFile = vi.fn();
const mockBotStart = vi.fn().mockResolvedValue(undefined);
const mockBotStop = vi.fn().mockResolvedValue(undefined);

vi.mock('grammy', () => ({
  Bot: vi.fn().mockImplementation(() => ({
    on: vi.fn().mockImplementation((filter: string, handler: Function) => {
      if (filter === 'message:text') textHandlers.push(handler);
      if (filter === 'message:photo') photoHandlers.push(handler);
      if (filter === 'message:document') documentHandlers.push(handler);
      if (filter === 'message:voice') voiceHandlers.push(handler);
    }),
    start: mockBotStart,
    stop: mockBotStop,
    botInfo: { username: 'CCBuddyBot' },
    api: {
      sendMessage: mockSendMessage,
      sendPhoto: mockSendPhoto,
      sendDocument: mockSendDocument,
      sendVoice: mockSendVoice,
      sendChatAction: mockSendChatAction,
      getFile: mockGetFile,
    },
  })),
  InputFile: vi.fn().mockImplementation((data: Buffer, filename: string) => ({
    data,
    filename,
  })),
}));

// Use vi.hoisted to ensure these are defined before the hoisted vi.mock calls
const { mockFetchAttachment, mockValidateAttachment } = vi.hoisted(() => ({
  mockFetchAttachment: vi.fn(),
  mockValidateAttachment: vi.fn(),
}));

vi.mock('@ccbuddy/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ccbuddy/core')>();
  return {
    ...actual,
    fetchAttachment: mockFetchAttachment,
    validateAttachment: mockValidateAttachment,
  };
});

import { TelegramAdapter } from '../telegram-adapter.js';
import type { IncomingMessage, MediaConfig } from '@ccbuddy/core';

const testMediaConfig: MediaConfig = {
  max_file_size_mb: 10,
  allowed_mime_types: ['image/jpeg', 'image/png', 'application/pdf'],
  voice_enabled: false,
  tts_max_chars: 500,
};

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
    api: {
      getFile: mockGetFile,
    },
  };
}

describe('TelegramAdapter', () => {
  let adapter: TelegramAdapter;
  let receivedMessages: IncomingMessage[];

  beforeEach(() => {
    vi.clearAllMocks();
    textHandlers.length = 0;
    photoHandlers.length = 0;
    documentHandlers.length = 0;
    voiceHandlers.length = 0;
    receivedMessages = [];
    adapter = new TelegramAdapter({ token: 'tg-token', mediaConfig: testMediaConfig });
    adapter.onMessage((msg) => receivedMessages.push(msg));

    // Default mocks
    mockGetFile.mockResolvedValue({ file_path: 'photos/file_123.jpg' });
    mockFetchAttachment.mockResolvedValue(Buffer.from('fakeimagedata'));
    mockValidateAttachment.mockReturnValue({ valid: true });
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

  describe('photo messages', () => {
    it('produces IncomingMessage with image attachment for photo message', async () => {
      await adapter.start();

      const ctx = {
        ...fakeTelegramCtx(),
        message: {
          from: { id: 456 },
          caption: 'Look at this!',
          reply_to_message: null,
          photo: [
            { file_id: 'small_id', width: 100, height: 100 },
            { file_id: 'large_id', width: 800, height: 600 },
          ],
        },
      };

      await photoHandlers[0](ctx);

      expect(mockGetFile).toHaveBeenCalledWith('large_id');
      expect(mockFetchAttachment).toHaveBeenCalledWith(
        'https://api.telegram.org/file/bottg-token/photos/file_123.jpg',
        expect.objectContaining({ maxBytes: 10 * 1024 * 1024 }),
      );
      expect(receivedMessages).toHaveLength(1);
      expect(receivedMessages[0]).toEqual(
        expect.objectContaining({
          platform: 'telegram',
          platformUserId: '456',
          channelId: '789',
          text: 'Look at this!',
          attachments: [
            expect.objectContaining({
              type: 'image',
              mimeType: 'image/jpeg',
              data: Buffer.from('fakeimagedata'),
            }),
          ],
        }),
      );
    });

    it('uses empty string as text when photo has no caption', async () => {
      await adapter.start();

      const ctx = {
        ...fakeTelegramCtx(),
        message: {
          from: { id: 456 },
          caption: undefined,
          reply_to_message: null,
          photo: [{ file_id: 'photo_id', width: 200, height: 200 }],
        },
      };

      await photoHandlers[0](ctx);

      expect(receivedMessages[0].text).toBe('');
    });

    it('skips attachment when validation fails', async () => {
      mockValidateAttachment.mockReturnValue({ valid: false, reason: 'File too large' });
      await adapter.start();

      const ctx = {
        ...fakeTelegramCtx(),
        message: {
          from: { id: 456 },
          caption: null,
          reply_to_message: null,
          photo: [{ file_id: 'photo_id', width: 200, height: 200 }],
        },
      };

      await photoHandlers[0](ctx);

      expect(receivedMessages).toHaveLength(0);
    });

    it('skips attachment when getFile returns no file_path', async () => {
      mockGetFile.mockResolvedValue({ file_path: undefined });
      await adapter.start();

      const ctx = {
        ...fakeTelegramCtx(),
        message: {
          from: { id: 456 },
          caption: null,
          reply_to_message: null,
          photo: [{ file_id: 'photo_id', width: 200, height: 200 }],
        },
      };

      await photoHandlers[0](ctx);

      expect(receivedMessages).toHaveLength(0);
    });

    it('skips attachment when download fails', async () => {
      mockFetchAttachment.mockRejectedValue(new Error('Network error'));
      await adapter.start();

      const ctx = {
        ...fakeTelegramCtx(),
        message: {
          from: { id: 456 },
          caption: null,
          reply_to_message: null,
          photo: [{ file_id: 'photo_id', width: 200, height: 200 }],
        },
      };

      await photoHandlers[0](ctx);

      expect(receivedMessages).toHaveLength(0);
    });
  });

  describe('document messages', () => {
    it('produces IncomingMessage with file attachment for document message', async () => {
      mockGetFile.mockResolvedValue({ file_path: 'documents/report.pdf' });
      mockFetchAttachment.mockResolvedValue(Buffer.from('pdfdata'));

      await adapter.start();

      const ctx = {
        ...fakeTelegramCtx(),
        message: {
          from: { id: 456 },
          caption: 'Here is the report',
          reply_to_message: null,
          document: {
            file_id: 'doc_file_id',
            mime_type: 'application/pdf',
            file_name: 'report.pdf',
          },
        },
      };

      await documentHandlers[0](ctx);

      expect(mockGetFile).toHaveBeenCalledWith('doc_file_id');
      expect(mockFetchAttachment).toHaveBeenCalledWith(
        'https://api.telegram.org/file/bottg-token/documents/report.pdf',
        expect.objectContaining({ maxBytes: 10 * 1024 * 1024 }),
      );
      expect(receivedMessages).toHaveLength(1);
      expect(receivedMessages[0]).toEqual(
        expect.objectContaining({
          platform: 'telegram',
          platformUserId: '456',
          channelId: '789',
          text: 'Here is the report',
          attachments: [
            expect.objectContaining({
              type: 'file',
              mimeType: 'application/pdf',
              data: Buffer.from('pdfdata'),
              filename: 'report.pdf',
            }),
          ],
        }),
      );
    });

    it('uses empty string as text when document has no caption', async () => {
      await adapter.start();

      const ctx = {
        ...fakeTelegramCtx(),
        message: {
          from: { id: 456 },
          caption: undefined,
          reply_to_message: null,
          document: {
            file_id: 'doc_id',
            mime_type: 'application/pdf',
            file_name: 'file.pdf',
          },
        },
      };

      await documentHandlers[0](ctx);

      expect(receivedMessages[0].text).toBe('');
    });

    it('falls back to octet-stream when document has no mime_type', async () => {
      await adapter.start();

      const ctx = {
        ...fakeTelegramCtx(),
        message: {
          from: { id: 456 },
          caption: null,
          reply_to_message: null,
          document: {
            file_id: 'doc_id',
            mime_type: undefined,
            file_name: 'unknown.bin',
          },
        },
      };

      await documentHandlers[0](ctx);

      expect(receivedMessages[0].attachments[0].mimeType).toBe('application/octet-stream');
      expect(receivedMessages[0].attachments[0].type).toBe('file');
    });

    it('captures reply reference for document message', async () => {
      await adapter.start();

      const ctx = {
        ...fakeTelegramCtx(),
        message: {
          from: { id: 456 },
          caption: null,
          reply_to_message: { message_id: 99 },
          document: {
            file_id: 'doc_id',
            mime_type: 'application/pdf',
            file_name: 'doc.pdf',
          },
        },
      };

      await documentHandlers[0](ctx);

      expect(receivedMessages[0].replyToMessageId).toBe('99');
    });
  });

  describe('voice messages', () => {
    it('produces IncomingMessage with voice attachment for voice message', async () => {
      mockGetFile.mockResolvedValue({ file_path: 'voice/file_abc.oga' });
      mockFetchAttachment.mockResolvedValue(Buffer.from('voicedata'));

      await adapter.start();

      const ctx = {
        ...fakeTelegramCtx(),
        message: {
          from: { id: 456 },
          reply_to_message: null,
          voice: {
            file_id: 'voice_file_id',
            mime_type: 'audio/ogg',
            duration: 5,
          },
        },
      };

      await voiceHandlers[0](ctx);

      expect(mockGetFile).toHaveBeenCalledWith('voice_file_id');
      expect(mockFetchAttachment).toHaveBeenCalledWith(
        'https://api.telegram.org/file/bottg-token/voice/file_abc.oga',
        expect.objectContaining({ maxBytes: 10 * 1024 * 1024 }),
      );
      expect(receivedMessages).toHaveLength(1);
      expect(receivedMessages[0]).toEqual(
        expect.objectContaining({
          platform: 'telegram',
          platformUserId: '456',
          channelId: '789',
          text: '',
          attachments: [
            expect.objectContaining({
              type: 'voice',
              mimeType: 'audio/ogg',
              data: Buffer.from('voicedata'),
              filename: 'voice.ogg',
            }),
          ],
        }),
      );
    });

    it('falls back to audio/ogg when voice has no mime_type', async () => {
      await adapter.start();

      const ctx = {
        ...fakeTelegramCtx(),
        message: {
          from: { id: 456 },
          reply_to_message: null,
          voice: {
            file_id: 'voice_file_id',
            mime_type: undefined,
            duration: 3,
          },
        },
      };

      await voiceHandlers[0](ctx);

      expect(receivedMessages[0].attachments[0].mimeType).toBe('audio/ogg');
    });

    it('skips voice attachment when validation fails', async () => {
      mockValidateAttachment.mockReturnValue({ valid: false, reason: 'File too large' });
      await adapter.start();

      const ctx = {
        ...fakeTelegramCtx(),
        message: {
          from: { id: 456 },
          reply_to_message: null,
          voice: {
            file_id: 'voice_file_id',
            mime_type: 'audio/ogg',
            duration: 5,
          },
        },
      };

      await voiceHandlers[0](ctx);

      expect(receivedMessages).toHaveLength(0);
    });

    it('skips voice attachment when getFile returns no file_path', async () => {
      mockGetFile.mockResolvedValue({ file_path: undefined });
      await adapter.start();

      const ctx = {
        ...fakeTelegramCtx(),
        message: {
          from: { id: 456 },
          reply_to_message: null,
          voice: {
            file_id: 'voice_file_id',
            mime_type: 'audio/ogg',
            duration: 5,
          },
        },
      };

      await voiceHandlers[0](ctx);

      expect(receivedMessages).toHaveLength(0);
    });

    it('skips voice attachment when download fails', async () => {
      mockFetchAttachment.mockRejectedValue(new Error('Network error'));
      await adapter.start();

      const ctx = {
        ...fakeTelegramCtx(),
        message: {
          from: { id: 456 },
          reply_to_message: null,
          voice: {
            file_id: 'voice_file_id',
            mime_type: 'audio/ogg',
            duration: 5,
          },
        },
      };

      await voiceHandlers[0](ctx);

      expect(receivedMessages).toHaveLength(0);
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

    it('sends voice', async () => {
      const buf = Buffer.from('audiodata');
      await adapter.sendVoice('789', buf);
      expect(mockSendVoice).toHaveBeenCalledWith(
        789,
        expect.objectContaining({ data: buf, filename: 'voice.ogg' }),
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
