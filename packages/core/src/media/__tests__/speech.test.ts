import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { SpeechService } from '../speech.js';

describe('SpeechService', () => {
  let service: SpeechService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new SpeechService('test-api-key');
  });

  it('calls OpenAI TTS API with correct parameters', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(100),
    });

    await service.synthesize('Hello world');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.openai.com/v1/audio/speech',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-api-key',
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify({
          model: 'tts-1',
          input: 'Hello world',
          voice: 'alloy',
          response_format: 'opus',
        }),
      }),
    );
  });

  it('returns audio buffer', async () => {
    const audioData = new Uint8Array([1, 2, 3, 4]);
    mockFetch.mockResolvedValue({
      ok: true,
      arrayBuffer: async () => audioData.buffer,
    });

    const result = await service.synthesize('test');
    expect(Buffer.isBuffer(result)).toBe(true);
    expect(result.length).toBe(4);
  });

  it('accepts custom voice parameter', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(10),
    });

    await service.synthesize('test', 'nova');

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.voice).toBe('nova');
  });

  it('throws on API error', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'Server Error',
    });

    await expect(service.synthesize('test')).rejects.toThrow('Speech synthesis failed');
  });
});
