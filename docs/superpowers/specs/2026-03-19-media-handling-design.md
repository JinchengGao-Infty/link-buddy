# Media Handling Design

## Summary

Enable CCBuddy to receive and send images and documents across platforms. Inbound: platform adapters download attachment data, a shared validator checks size/mime, agent backends convert to Claude vision/document format. Outbound: skills return media in their output, the gateway routes to platform adapters.

## Context

The attachment pipeline is structurally in place (types, events, storage column) but functionally empty. Discord attachments arrive as `Buffer.alloc(0)` placeholders. Telegram ignores non-text messages entirely. Agent backends don't pass attachments to Claude. The gateway never stores attachment metadata. This spec fills in the missing implementation.

## Design

### Inbound Media Pipeline

**Flow:** Adapter downloads → shared validator → gateway → conversion helper → agent backend → Claude API

#### Platform Adapters

**Discord** (`packages/platforms/discord/src/discord-adapter.ts`):
- Discord.js `Attachment` objects have a `url` property pointing to the CDN.
- `normalizeMessage()` is currently synchronous. It must become `async` to support the download step. The `messageCreate` handler call site must also be updated to `await` it.
- After building each `Attachment` object, fetch the binary data from `att.url` using the shared download helper.
- Populate `Attachment.data` with the actual `Buffer` instead of `Buffer.alloc(0)`.
- Run the shared validator. If invalid (too large, disallowed mime), omit the attachment and send a brief notice to the channel (e.g. "Attachment skipped: file too large (max 10MB)").

**Telegram** (`packages/platforms/telegram/src/telegram-adapter.ts`):
- Currently only listens to `'message:text'` events. Add listeners for `'message:photo'`, `'message:document'`.
- For photos: grammY provides `ctx.message.photo` as an array of `PhotoSize` sorted by size ascending. Pick the last element (largest). Call `ctx.api.getFile(fileId)` to get a file path, then download via the Telegram Bot API file URL (`https://api.telegram.org/file/bot<token>/<file_path>`).
- For documents: `ctx.message.document` has `file_id` and `mime_type`. Same download flow.
- Note: Telegram users can send photos as documents (uncompressed). Both handlers must produce valid `Attachment` objects.
- Use `ctx.message.caption` as the text content when photos/documents have captions.
- Construct `Attachment` objects with the downloaded data, run validator.

**Future Platforms:**
- Any new adapter implements: "download binary from platform SDK, construct `Attachment`, call validator." Everything downstream is shared.
- The shared download helper handles the common case of HTTP URL → Buffer.

#### Shared Utilities (new in `@ccbuddy/core`)

**Download helper** — `fetchAttachment(url: string, opts?: { timeoutMs?: number; maxBytes?: number }): Promise<Buffer>`:
- Uses Node's native `fetch()` with `AbortSignal.timeout()` (default 30s).
- Streams the response and enforces `maxBytes` limit during streaming (default: `max_file_size_mb * 1024 * 1024`). Aborts if exceeded, avoiding full buffer of oversized files.
- Returns the response body as a Buffer.
- Throws on HTTP errors, network failures, timeout, or size exceeded.

**Validator** — `validateAttachment(attachment: Attachment, config: MediaConfig): { valid: boolean; reason?: string }`:
- Checks `attachment.data.byteLength` against `config.max_file_size_mb * 1024 * 1024`.
- Checks `attachment.mimeType` against `config.allowed_mime_types`.
- Returns rejection reason if invalid.
- Note: Claude vision supports JPEG, PNG, GIF, WebP for images and PDF for documents. SVG is not supported by Claude and should not be added to `allowed_mime_types`.

**Conversion helper** — `attachmentsToContentBlocks(attachments: Attachment[]): ContentBlock[]`:
- Converts image attachments (identified by `mimeType` starting with `image/`) to:
  ```typescript
  { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64String } }
  ```
- Converts PDF attachments (identified by `mimeType === 'application/pdf'`) to:
  ```typescript
  { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64String } }
  ```
- Skips unsupported types (e.g. voice without transcript). Returns empty array if no convertible attachments.
- Returns an array of content blocks to combine with the text prompt.

#### Gateway

- Already passes attachments to agent request — no structural changes needed for inbound routing.
- `StoreMessageParams` interface needs a new `attachments?: string` field. The bootstrap `storeMessage` wiring must pass it through to `messageStore.add()`.
- When storing user messages, serialize attachment metadata (type, mime, filename, byte size) as JSON. Not the binary data — just metadata for memory context.
- Format: `[{ type: "image", mimeType: "image/png", filename: "photo.jpg", bytes: 45230 }]`
- When the validator rejects an attachment, the adapter sends a brief explanation to the user before proceeding with the text-only message.

#### Agent Backends

**SDK Backend** (`packages/agent/src/backends/sdk-backend.ts`):
- If `request.attachments` is non-empty, use the conversion helper to build content blocks.
- The SDK's `query()` accepts `prompt: string | AsyncIterable<SDKUserMessage>`. To pass content blocks, use the `AsyncIterable<SDKUserMessage>` form. Construct a single `SDKUserMessage` with a multi-part content array:
  ```typescript
  const contentBlocks = attachmentsToContentBlocks(request.attachments);
  const message: SDKUserMessage = {
    type: 'user',
    message: {
      role: 'user',
      content: [
        ...contentBlocks,
        { type: 'text', text: fullPrompt },
      ],
    },
  };
  ```
- Yield this as an async iterable to `query()`.
- When no attachments are present, continue using the existing string prompt path.

**CLI Backend** (`packages/agent/src/backends/cli-backend.ts`):
- The Claude CLI (`claude -p`) has no flags for images or attachments.
- When attachments are present, log a warning: `[CliBackend] Attachments not supported in CLI mode — including metadata only`.
- Include attachment metadata in the prompt text as a note: `[Attached: image/png "photo.jpg" (45KB)]`. This way the agent knows something was sent even though it can't see it.
- This is a known limitation. The SDK backend is the primary backend for production use; CLI is the fallback.

#### Memory

- Add `attachments?: string` to `StoreMessageParams` in `packages/gateway/src/gateway.ts`.
- Update `storeMessage` closure in `packages/main/src/bootstrap.ts` to pass the `attachments` field through to `messageStore.add()`.
- Gateway serializes attachment metadata when calling `storeMessage()`.

### Outbound Media Pipeline

**Flow:** Skill returns media → MCP server passes in tool result → agent backend emits media event → gateway delivers via adapter

#### Skill Output Format

Skills can return media alongside their text result:

```typescript
interface SkillMediaOutput {
  data: string;      // base64-encoded binary
  mimeType: string;
  filename?: string;
}

interface SkillOutput {
  success: boolean;
  result?: unknown;
  error?: string;
  media?: SkillMediaOutput[];  // array — a skill can return multiple media items
}
```

#### Concrete Outbound Flow

1. **Skill execution:** A skill (e.g. `generate_image`) returns `{ success: true, result: "Here's your image", media: [{ data: "base64...", mimeType: "image/png", filename: "output.png" }] }`.

2. **MCP server:** The `CallToolRequestSchema` handler already returns `JSON.stringify(output)` as the tool result text. The media payload is embedded in this JSON. For large images this can be substantial, but it's a single tool call result — acceptable for the current scale.

3. **Agent response:** The agent receives the tool result containing the media field. It crafts a text response describing the output.

4. **Agent event stream:** Add a new `AgentEvent` variant:
   ```typescript
   interface AgentMediaEvent {
     type: 'media';
     media: Array<{ data: Buffer; mimeType: string; filename?: string }>;
   }
   ```
   The agent backend, when processing tool results that contain media fields, emits `media` events alongside the normal text events. The backend parses tool result JSON, detects the `media` field, decodes base64 to Buffer, and emits the event.

5. **Gateway:** The `executeAndRoute` method handles the new `media` event type:
   ```typescript
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
   ```

This approach uses the existing event stream without fragile text parsing. The agent doesn't need special markers — the backend detects media in tool results automatically.

### Voice Extensibility

Not implemented now. The design accommodates voice via:
- `Attachment.type` already supports `'voice'`
- `Attachment.transcript` field exists for transcribed text
- A future transcription step slots between adapter download and gateway
- Transcription backend interface: `transcribe(audio: Buffer, mimeType: string): Promise<string>`
- Adding voice means: add audio mime types to config, implement transcription step, update agent backend to include transcript in prompt

### Config Changes

No changes needed to `config/default.yaml` — the current `allowed_mime_types` list already covers images (JPEG, PNG, GIF, WebP) and PDF. Voice types (`audio/ogg`, `audio/mp4`) will be added when voice is implemented. SVG is intentionally excluded as Claude does not support it for vision.

### Testing Strategy

- **Download helper:** Unit test with a mock HTTP server, verify Buffer output, timeout, size limit enforcement, error handling.
- **Validator:** Unit test with various sizes and mime types, verify accept/reject with reasons.
- **Conversion helper:** Unit test that image/PDF attachments produce correct Claude content block format. Verify unsupported types are skipped.
- **Discord adapter:** Integration test that attachments are downloaded and populated (mock the HTTP fetch). Test the async normalizeMessage refactor.
- **Telegram adapter:** Integration test for photo/document message types (mock grammY API). Test caption handling.
- **SDK backend:** Unit test that attachments are converted to SDKUserMessage content blocks.
- **CLI backend:** Unit test that attachments produce metadata-only prompt text with warning log.
- **Gateway media storage:** Unit test that `StoreMessageParams` passes attachments through to message store.
- **Outbound pipeline:** Unit test that skill output with media emits `AgentMediaEvent`, and gateway routes it to adapter sendImage/sendFile.

### File Change Summary

| File | Change |
|------|--------|
| `packages/core/src/media/download.ts` | New: shared download helper with timeout + size limit |
| `packages/core/src/media/validator.ts` | New: shared attachment validator |
| `packages/core/src/media/conversion.ts` | New: attachment → Claude content block conversion |
| `packages/core/src/media/index.ts` | New: barrel export |
| `packages/core/src/types/agent.ts` | Modify: add `AgentMediaEvent` to `AgentEvent` union |
| `packages/platforms/discord/src/discord-adapter.ts` | Modify: async normalizeMessage, download attachments, validate |
| `packages/platforms/telegram/src/telegram-adapter.ts` | Modify: listen for photo/document, download, validate, caption |
| `packages/agent/src/backends/sdk-backend.ts` | Modify: build SDKUserMessage with content blocks for attachments |
| `packages/agent/src/backends/cli-backend.ts` | Modify: metadata-only fallback with warning |
| `packages/gateway/src/gateway.ts` | Modify: add attachments to StoreMessageParams, handle media events in executeAndRoute |
| `packages/main/src/bootstrap.ts` | Modify: pass attachments in storeMessage closure |
| `packages/skills/src/types.ts` | Modify: add `media?: SkillMediaOutput[]` to SkillOutput |

## Not In Scope

- Voice message handling (extensibility designed in, implementation deferred)
- Image generation skill (immediate follow-up with nano banana 2 after this lands)
- Attachment caching or streaming
- `send_file` MCP tool (skills handle outbound media)
- Attachment binary storage in SQLite (only metadata stored)
- SVG support (not supported by Claude vision)
