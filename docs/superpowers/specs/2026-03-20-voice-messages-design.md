# Voice Messages Design

## Overview

Add bidirectional voice message support: inbound STT (OpenAI Whisper) transcribes user voice messages to text, outbound TTS (OpenAI TTS) synthesizes voice replies. Voice input mirrors voice output — if you speak, CCBuddy speaks back. Gated by `voice_enabled` config flag (default: false).

## Config

Add to `MediaConfig` in `packages/core/src/config/schema.ts`:

```typescript
export interface MediaConfig {
  max_file_size_mb: number;
  allowed_mime_types: string[];
  voice_enabled: boolean;        // default: false
  stt_backend: 'openai-whisper'; // extensible for future backends
  tts_backend: 'openai-tts';     // extensible for future backends
  tts_max_chars: number;         // default: 500
}
```

Requires `OPENAI_API_KEY` environment variable when `voice_enabled: true`.

## STT Pipeline (Inbound Voice)

### TranscriptionService

`packages/core/src/media/transcription.ts`:

```typescript
class TranscriptionService {
  constructor(apiKey: string)
  transcribe(audio: Buffer, mimeType: string): Promise<string>
}
```

- Calls `https://api.openai.com/v1/audio/transcriptions` with `model: 'whisper-1'`
- Sends audio as multipart form data with appropriate file extension based on MIME type
- Accepts: `audio/ogg`, `audio/mp4`, `audio/wav`, `audio/mpeg`, `audio/webm`
- Returns transcript text string

### Platform Adapter Changes

**Discord:** In attachment processing, detect `audio/*` MIME types. Set `type: 'voice'`. If `voice_enabled`, call `TranscriptionService.transcribe()` and populate `Attachment.transcript`.

**Telegram:** Add `message:voice` event listener. Telegram sends voice messages as OGG/Opus. Download via `getFile` API, transcribe, create attachment with `type: 'voice'` and `transcript`.

Both adapters: if `voice_enabled` is false, voice messages are ignored or treated as generic file attachments.

### Gateway Change

When a message has voice attachments with a `transcript`, prepend to prompt: `[Voice message] {transcript}`. Set a flag on the request indicating voice input (for mirror logic).

## TTS Pipeline (Outbound Voice)

### SpeechService

`packages/core/src/media/speech.ts`:

```typescript
class SpeechService {
  constructor(apiKey: string)
  synthesize(text: string, voice?: string): Promise<Buffer>
}
```

- Calls `https://api.openai.com/v1/audio/speech` with `model: 'tts-1'`, `response_format: 'opus'`
- Returns OGG/Opus buffer — natively supported by Discord and Telegram
- Default voice: `'alloy'`

### Mirror Logic (Gateway)

Track whether the incoming message was a voice message. On agent response:

- **Voice input + response ≤ `tts_max_chars` (500):** Synthesize entire response via SpeechService, send as voice message
- **Voice input + response > `tts_max_chars`:** Synthesize first `tts_max_chars` characters as voice, send remainder as text
- **Text input:** Send as text (no TTS)

### Platform Adapter Additions

**Discord:** `sendVoice(channelId: string, audio: Buffer, filename?: string): Promise<void>` — sends as message attachment with `.ogg` extension.

**Telegram:** `sendVoice(channelId: string, audio: Buffer): Promise<void>` — uses grammY `sendVoice` API method.

## Bootstrap Wiring

In `packages/main/src/bootstrap.ts`:

1. If `config.media.voice_enabled`:
   - Read `OPENAI_API_KEY` from environment
   - Create `TranscriptionService` and `SpeechService`
   - Pass to Gateway deps (new optional fields: `transcriptionService?`, `speechService?`)
   - Pass to platform adapter constructors (or inject via Gateway)

## Testing Strategy

### TranscriptionService (unit)
- Mock fetch — verify correct OpenAI endpoint, model, multipart form body
- Test transcript extraction from response JSON
- Test error handling (API error, invalid response)

### SpeechService (unit)
- Mock fetch — verify correct endpoint, model, voice, response_format
- Test audio buffer returned
- Test error handling

### Platform Adapters (unit)
- Discord: audio attachment detected as `type: 'voice'`, transcript populated
- Telegram: `message:voice` listener fires, downloads and transcribes
- Both: `sendVoice` sends audio buffer correctly
- Both: voice ignored when `voice_enabled: false`

### Gateway (unit)
- Voice message transcript prepended to prompt
- Mirror: voice input → voice response (≤500 chars)
- Mirror: voice input → voice + text (>500 chars)
- Text input → text response (no TTS)

### Integration
- Manual smoke test on Discord: send voice message, verify transcription + voice reply
