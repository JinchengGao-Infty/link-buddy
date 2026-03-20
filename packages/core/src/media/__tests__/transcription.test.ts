import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { TranscriptionService } from '../transcription.js';

describe('TranscriptionService', () => {
  let service: TranscriptionService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new TranscriptionService('test-api-key');
  });

  it('calls OpenAI Whisper API with correct endpoint and auth', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ text: 'Hello world' }),
    });

    await service.transcribe(Buffer.from('audio-data'), 'audio/ogg');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.openai.com/v1/audio/transcriptions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-api-key',
        }),
      }),
    );
  });

  it('returns transcript text', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ text: 'Hello world' }),
    });

    const result = await service.transcribe(Buffer.from('audio'), 'audio/ogg');
    expect(result).toBe('Hello world');
  });

  it('sends audio as multipart form data with correct filename extension', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ text: 'test' }),
    });

    await service.transcribe(Buffer.from('audio'), 'audio/mp4');

    const call = mockFetch.mock.calls[0];
    const body = call[1].body as FormData;
    expect(body).toBeInstanceOf(FormData);
  });

  it('throws on API error', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
    });

    await expect(service.transcribe(Buffer.from('audio'), 'audio/ogg'))
      .rejects.toThrow('Transcription failed');
  });
});
