# CCBuddy — Design Specification

**Date:** 2026-03-16
**Status:** Draft
**Author:** flyingchickens + Claude

## 1. Overview

CCBuddy is a personal AI assistant that runs on a Mac Mini and is accessible via Discord, Telegram, and future messaging platforms. It uses **Claude Code (unmodified)** as its core agent, routing all tasks — chat, coding, system operations, and maintenance — through Claude Code for intelligent processing.

### Core Principles

1. **Claude Code is the brain.** Every operation goes through CC. No dumb scripts bypassing it.
2. **Claude Code is unmodified.** CCBuddy wraps around CC via its official SDK/CLI. CC updates never break CCBuddy.
3. **Modular architecture.** Each module (gateway, memory, scheduler, etc.) is independent, replaceable, and communicates only through an event bus.
4. **All tunables are configurable.** Every threshold, interval, and limit has a sensible default and can be overridden via config.
5. **Designed for future extensibility.** New platforms, storage backends, retrieval strategies, and features plug in without modifying existing modules.

### Key Constraints

- Uses Claude Max subscription (no API costs). Both SDK and CLI use Max auth.
- Must not violate Anthropic usage policies. This is a personal assistant on user's own hardware.
- Local Claude Code usage must coexist without interference from CCBuddy.

## 2. System Architecture

Monorepo with independent module packages, orchestrated by a process manager, communicating through an abstract event bus.

```
                    ┌─────────────────────────────────────┐
                    │            Orchestrator              │
                    │  (process manager, startup/shutdown) │
                    └──────────────┬──────────────────────┘
                                   │ manages
        ┌──────────┬───────────┬───┴────┬──────────┬──────────┐
        ▼          ▼           ▼        ▼          ▼          ▼
   ┌─────────┐ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐
   │ Gateway │ │ Agent  │ │ Memory │ │Scheduler│ │Heartbeat│ │Webhooks│
   └────┬────┘ └────────┘ └────────┘ └────────┘ └────────┘ └────────┘
        │                        ▲
        │          Event Bus (pub/sub)
        │    ◄─────────────────────────────────────────────────►
        │
   ┌────┴──────────────┐
   │  Platform Adapters │
   ├────────┬───────────┤
   │Discord │ Telegram  │  (+ future: WhatsApp, iMessage, etc.)
   └────────┴───────────┘
```

### Message Flow (Incoming Chat)

1. Discord/Telegram adapter receives message
2. Adapter normalizes it into a standard `IncomingMessage` format
3. Gateway identifies the user (via platform account mapping), resolves permissions
4. Gateway publishes `message.incoming` event on the event bus
5. Memory module retrieves relevant context for this user
6. Agent module invokes Claude Code SDK with the message + memory context
7. Agent publishes `message.outgoing` event with CC's response
8. Gateway routes the response back through the originating platform adapter

### Event Bus

No module directly imports or calls another. All communication goes through the event bus.

```typescript
interface EventBus {
  publish(event: string, payload: any): Promise<void>
  subscribe(event: string, handler: (payload: any) => void): void
}
```

- Current implementation: in-process IPC or local Redis pub/sub
- Future upgrade path: swap to NATS/RabbitMQ for distributed deployment without changing module code

### Orchestrator & Crash Recovery

The orchestrator is managed by macOS `launchd` as a system daemon.

```
launchd (macOS built-in, always running)
  └── watches & restarts ──► Orchestrator
                                └── watches & restarts ──► all modules
```

Recovery behavior:
- Orchestrator writes child process PIDs to a state file on disk
- On restart, checks which children survived (children don't die with parent in Node.js)
- Reconnects to surviving children, restarts dead ones
- Event bus subscriptions re-establish automatically
- Worst case (full reboot): launchd starts orchestrator, orchestrator starts all modules. Platform message buffers deliver missed messages on reconnect.

The orchestrator is kept as thin as possible (start, monitor, stop processes) to minimize crash surface.

## 3. Agent Module

Abstraction layer over Claude Code with swappable backends.

### Interface

```typescript
interface AgentBackend {
  execute(request: AgentRequest): AsyncGenerator<AgentEvent>
  abort(sessionId: string): Promise<void>
}

interface AgentRequest {
  prompt: string
  userId: string
  sessionId: string
  workingDirectory?: string
  allowedTools?: string[]
  systemPrompt?: string
  memoryContext?: string
  attachments?: Attachment[]
  permissionLevel: 'admin' | 'chat'
}

type AgentEvent =
  | { type: 'text', content: string }
  | { type: 'tool_use', tool: string }
  | { type: 'complete', response: string }
  | { type: 'error', error: string }
```

### Backends

**Primary — SDK Backend:**
- Uses `@anthropic-ai/claude-code` SDK
- Streams events in real-time
- In-process, no shell spawning overhead after initial setup

**Fallback — CLI Backend:**
- Spawns `claude -p <prompt> --session-id <id> --output-format stream-json`
- Parses streaming JSON into same `AgentEvent` stream
- Swappable with one config change

### Permission Enforcement

| Role | Capabilities |
|---|---|
| `admin` | All tools, all working directories, full filesystem/bash access |
| `chat` | No bash, no file edit, no file read. Text conversation only |

### Session Conflict Detection

Before executing a write-capable request, the agent module checks for active `claude` processes in the target working directory.

- **Read-only tasks:** proceed without checking
- **Write tasks with conflict detected:** publish `session.conflict` event → gateway notifies admin via chat with options: (1) proceed anyway, (2) work in a worktree, (3) queue until done

### Concurrency

Multiple agent sessions can run in parallel (different users, different projects). Max concurrent sessions is configurable to respect Max plan rate limits.

## 4. Memory Module

LCM-inspired (Lossless Claw) DAG-based memory system. The most critical module.

### Storage Schema

```
SQLite Database
├── messages              # every raw message, never deleted
│   ├── id
│   ├── user_id
│   ├── session_id
│   ├── platform          # discord, telegram, local
│   ├── content
│   ├── role              # user, assistant
│   ├── attachments       # media references
│   ├── timestamp
│   └── tokens            # token count for budget tracking
│
├── summary_nodes         # DAG nodes
│   ├── id
│   ├── user_id
│   ├── depth             # 0=leaf, 1=condensed, 2=higher...
│   ├── content           # the summary text
│   ├── source_ids        # messages or nodes this summarizes
│   ├── tokens
│   └── timestamp
│
└── user_profiles         # persistent per-user facts
    ├── user_id
    ├── key
    ├── value
    └── updated_at
```

### DAG Summarization Flow

```
Raw messages accumulate
        │
        ▼  (threshold reached: configurable, default 75% of token budget)
Leaf summarization
  Group older messages into chunks → Claude Code summarizes each
  Result: depth-0 summary nodes linking to source messages
        │
        ▼  (enough leaf nodes accumulate)
Condensation sweep
  Group leaf summaries → Claude Code condenses into depth-1 nodes
  Depth-aware prompts: leaves keep concrete details, higher levels capture patterns
        │
        ▼  (repeats as needed)
Higher-level condensation (depth-2, 3, ...)
```

### Context Assembly (Per Message)

1. Retrieve user profile (persistent facts/preferences)
2. Retrieve fresh tail (last N raw messages from current session, configurable, default 32)
3. Retrieve relevant summary nodes (recency + keyword relevance)
4. Calculate combined token count
5. Under budget → assemble and pass to agent module
6. Over budget → trigger compaction, reassemble

### Retrieval Tools (Injected into Claude Code)

| Tool | Purpose |
|---|---|
| `memory_grep` | Full-text search across stored messages and summaries for this user |
| `memory_describe` | Summarize a specific time range or topic from history |
| `memory_expand` | Drill into a summary node to recover original details |

These let Claude Code actively search memory when it needs context beyond what passive assembly provides.

### Per-User Isolation

All queries scoped to `user_id`. Each family member has fully separate conversation history, summary DAGs, and user profiles.

### Cross-Platform Continuity

Messages from all platforms go into the same table with the same `user_id`. The DAG doesn't distinguish platforms. Conversation started on Discord is seamlessly continued on Telegram.

### Session vs Memory Model

- **Memory (per-user, unified):** Long-term knowledge — preferences, facts, past topics. One DAG per user across all platforms.
- **Session context (per-channel):** Active working context for this conversation thread. Keeps unrelated conversations from polluting each other.
- When starting a new session, Claude Code queries the memory DAG for relevant context, providing continuity without merging unrelated threads.

### Consolidation

A scheduled cron job (configurable, default daily at 3am) where Claude Code reviews the DAG: merges duplicates, updates stale facts, prunes contradicted information. CC is the brain for memory housekeeping.

### Future Extensibility

- Storage backend interface: swap SQLite for PostgreSQL
- Retrieval strategy interface: add vector/semantic search (RAG) alongside keyword search
- Summary strategy interface: experiment with different summarization approaches

## 5. Gateway & Platform Adapters

### Gateway

Central message router handling user identification, permissions, session resolution, and activation mode.

1. Identify user via platform account mapping
2. Check permission level (admin/chat)
3. Resolve session context (per-channel, with unified user memory)
4. Check activation mode (all messages vs @mention only)
5. Publish to event bus

### Platform Adapter Interface

```typescript
interface PlatformAdapter {
  readonly platform: string

  start(): Promise<void>
  stop(): Promise<void>

  onMessage(handler: (msg: IncomingMessage) => void): void

  sendText(channelId: string, text: string): Promise<void>
  sendImage(channelId: string, image: Buffer, caption?: string): Promise<void>
  sendFile(channelId: string, file: Buffer, filename: string): Promise<void>

  setTypingIndicator(channelId: string, active: boolean): Promise<void>
}

interface IncomingMessage {
  platform: string
  platformUserId: string
  channelId: string
  channelType: 'dm' | 'group'
  text: string
  attachments: Attachment[]
  isMention: boolean
  replyToMessageId?: string
  raw: any
}
```

### Adding a New Platform

Requires only:
1. New adapter implementing `PlatformAdapter`
2. Platform user IDs added to user config
3. Adapter registered with gateway

No changes to any other module.

### Response Handling

- Long responses auto-chunked to platform limits (Discord: 2000 chars, Telegram: 4096 chars — configurable)
- Typing indicator shown while Claude Code processes
- Streaming progress for admin: "Analyzing code..." → "Running tests..." → final response
- Errors formatted gracefully for end users

### Activation Modes (Per-Channel Config)

```yaml
channels:
  discord:
    "family-general":
      mode: "mention"     # only respond when @CCBuddy
    "dev":
      mode: "all"         # respond to all messages
```

### Unknown Users

Messages from unmapped accounts are ignored by default. Optionally replies with "I don't recognize you. Ask the admin to add you."

## 6. User Management & Access Control

### User Config

```yaml
users:
  - name: "Dad"
    role: admin
    discord_id: "123456789"
    telegram_id: "987654321"
  - name: "Son"
    role: chat
    discord_id: "234567890"
    telegram_id: "876543210"
```

### Cross-Platform Identity

Platform accounts map to a single user identity. CCBuddy recognizes "Dad" whether messaging from Discord or Telegram, and maintains the same memory DAG.

### Permission Tiers

| Role | Chat | File/Code Access | Bash/System | Apple Tools | Skill Creation |
|---|---|---|---|---|---|
| `admin` | Full | Full | Full | Full | Full |
| `chat` | Full | None | None | Configurable per tool | Restricted sandbox |

## 7. Scheduler Module

All scheduled tasks are prompts to Claude Code.

### Job Configuration

```yaml
jobs:
  - name: "morning-briefing-dad"
    cron: "0 8 * * *"
    user: "dad"
    prompt: "Check my GitHub notifications, calendar for today, and any pending reminders. Summarize."
    deliver_to: "telegram:dad-dm"

  - name: "disk-health-check"
    cron: "0 */6 * * *"
    user: "dad"
    prompt: "Check disk usage, CPU, memory on this Mac Mini. Alert me if anything looks concerning."
    deliver_to: "telegram:dad-dm"
    only_if_notable: true

  - name: "memory-consolidation"
    cron: "0 3 * * *"
    user: "system"
    prompt: "Review all users' memory DAGs. Merge duplicates, update stale facts, prune contradictions."
    internal: true
```

### Features

- `only_if_notable` — CC evaluates whether the result is worth reporting. Suppresses "all clear" noise.
- `internal` — maintenance jobs with no user-facing output
- Jobs manageable via config file AND via chat ("CCBuddy, remind me every Monday to review PRs")
- Each execution is a fresh agent session with the specified user's permissions and memory

## 8. Heartbeat Module

Monitors CCBuddy's own health.

### Health Checks (configurable interval, default 60s)

- Is each platform adapter connected?
- Is the event bus responsive?
- Is the agent module able to reach Claude Code?
- Is SQLite (memory DB) accessible?
- Mac Mini system resources (CPU/memory/disk)

### Alerting

- Check failure → publish `alert.health` event → deliver to admin's configured channel
- Escalation: consecutive failures increase alert frequency (configurable intervals, default: 60s, 300s, 900s)
- Claude Code unreachable: reported directly by heartbeat without waiting for CC to evaluate

### Queryable

"CCBuddy, how are you doing?" or `/status` returns a health summary.

## 9. Webhooks Module

HTTP server accepting inbound webhooks, converting them into event bus messages for Claude Code to process.

### Flow

```
External service → HTTP POST → Webhooks Module → validate secret →
normalize payload → publish webhook.received event → Gateway →
Agent (CC interprets payload and decides action)
```

### Handler Config

```yaml
webhooks:
  port: 18800
  handlers:
    - name: "github"
      path: "/hooks/github"
      secret: "${GITHUB_WEBHOOK_SECRET}"
      user: "dad"
      prompt_template: "GitHub event received: {{payload}}. Analyze and take appropriate action."

    - name: "sentry"
      path: "/hooks/sentry"
      secret: "${SENTRY_WEBHOOK_SECRET}"
      user: "dad"
      prompt_template: "Sentry alert: {{payload}}. Investigate the error, find root cause, and suggest a fix."
```

### Security

- Per-handler secrets for validation
- Exposed to internet via Tailscale Funnel or Cloudflare Tunnel (not direct port forwarding)

## 10. Media Module

Handles inbound media (images, files, voice) and outbound image generation.

### Inbound Processing

| Type | Handling |
|---|---|
| Images | Pass through to Claude Code (native image support) |
| Files (PDF, code, text) | Extract content, pass as text to CC |
| Voice messages | STT preprocessing → transcript text → CC |
| Large files | Store separately with summary in memory (configurable threshold, default 25000 tokens) |

### STT Interface

```typescript
interface STTBackend {
  transcribe(audio: Buffer, format: string): Promise<string>
}
```

- Primary: local Whisper (free, private, no network)
- Fallback: OpenAI Whisper API or AssemblyAI
- Swappable via config

### Image Generation

```typescript
interface ImageGenerationBackend {
  generate(prompt: string): Promise<Buffer>
}
```

- Registered as a custom tool (`generate_image`) available to Claude Code
- CC decides when to use it based on user request
- Backend swappable: DALL-E API, Stable Diffusion API, or local model

### Temp File Lifecycle

- Inbound files saved to temp directory with configurable TTL (default 24 hours)
- Cleanup runs as a scheduled maintenance task

## 11. Apple Ecosystem Module

Native macOS integrations exposed as custom tools for Claude Code.

### Tools

```
├── apple_calendar     (list_events, create_event, delete_event)
├── apple_reminders    (list_reminders, create_reminder, complete_reminder)
├── apple_notes        (search_notes, read_note, create_note, update_note)
└── apple_shortcuts    (list_shortcuts, run_shortcut)
```

### Implementation

- Uses `osascript` (AppleScript/JXA) under the hood
- Each tool is a thin wrapper: validate input → execute AppleScript → parse result → return
- Apple Shortcuts bridge unlocks HomeKit, Focus modes, app automation

### Permission Scoping

- Admin: full access to all Apple tools
- Chat-only users: configurable per tool (e.g., read calendar but not create events)

## 12. Self-Evolving Skills Module (High Priority)

When Claude Code encounters a task it can't handle, it creates a new tool. This is a high-priority module — implement early after core foundation.

### Skill Lifecycle

1. **Creation** — CC writes tool code + metadata (name, description, input schema)
2. **Validation** — skills module checks syntax, dangerous imports, sandboxing
3. **Registration** — added to `registry.yaml`, available in future sessions
4. **Usage** — CC calls it like any other tool
5. **Evolution** — CC can update existing skills if they break or need improvement

### Directory Structure

```
skills/
├── registry.yaml          # manifest of all installed skills
├── bundled/               # ships with CCBuddy
├── generated/             # created by Claude Code at runtime
└── user/                  # manually added by user
```

### Safety Guardrails

- Generated skills run in a sandboxed context
- Admin approval required for skills requesting elevated permissions (network, filesystem, shell)
- Chat-only user skill creation: restricted sandbox (configurable)
- All generated skills committed to git for audit trail

### Unified Tool Registry

All modules (apple, media, memory, etc.) register their tools through the same skill registry. One unified system for both built-in and generated tools.

## 13. Configuration System

### Config Structure

```yaml
ccbuddy:
  data_dir: "./data"
  log_level: "info"

  users: [...]

  agent:
    backend: "sdk"                     # "sdk" or "cli"
    max_concurrent_sessions: 3
    default_working_directory: "~"
    admin_skip_permissions: true
    session_timeout_minutes: 30

  memory:
    db_path: "./data/memory.sqlite"
    context_threshold: 0.75
    fresh_tail_count: 32
    leaf_chunk_tokens: 20000
    leaf_target_tokens: 1200
    condensed_target_tokens: 2000
    max_expand_tokens: 4000
    consolidation_cron: "0 3 * * *"

  gateway:
    unknown_user_reply: true

  platforms:
    discord:
      enabled: true
      token: "${DISCORD_BOT_TOKEN}"
      channels: { ... }
    telegram:
      enabled: true
      token: "${TELEGRAM_BOT_TOKEN}"
      channels: { ... }

  scheduler:
    jobs: [...]

  heartbeat:
    interval_seconds: 60
    alert_channel: "telegram:dad-dm"
    escalation_intervals: [60, 300, 900]

  webhooks:
    enabled: true
    port: 18800
    handlers: [...]

  media:
    stt_backend: "local-whisper"
    temp_dir: "./data/temp"
    temp_ttl_hours: 24
    large_file_token_threshold: 25000

  image_generation:
    backend: "dall-e"
    api_key: "${IMAGE_GEN_API_KEY}"

  skills:
    generated_dir: "./skills/generated"
    sandbox_enabled: true
    require_admin_approval_for_elevated: true
    auto_git_commit: true

  apple:
    calendar: true
    reminders: true
    notes: true
    shortcuts: true
    chat_user_permissions:
      calendar: "read"
      reminders: "read_write"
      notes: "read"
      shortcuts: "none"
```

### Config Loading Priority (Highest to Lowest)

1. Environment variables (`CCBUDDY_AGENT_BACKEND=cli`)
2. `config/local.yaml` (git-ignored, personal overrides)
3. `config/default.yaml` (committed, sensible defaults)

## 14. Project Structure

```
ccbuddy/
├── packages/
│   ├── core/              # shared types, interfaces, config loader, event bus
│   ├── agent/             # Claude Code SDK/CLI abstraction
│   ├── memory/            # DAG storage, summarization, retrieval tools
│   ├── gateway/           # message routing, user identification, session mgmt
│   ├── platforms/
│   │   ├── discord/       # Discord.js bot adapter
│   │   └── telegram/      # grammY bot adapter
│   ├── scheduler/         # cron job management
│   ├── heartbeat/         # health monitoring
│   ├── webhooks/          # inbound webhook HTTP server
│   ├── media/             # image/file/voice processing, image generation
│   ├── skills/            # self-evolving skill system, tool registry
│   ├── apple/             # Calendar, Reminders, Notes, Shortcuts
│   └── orchestrator/      # process manager, launchd integration
├── skills/
│   ├── bundled/           # built-in tools
│   ├── generated/         # CC-created tools (git tracked)
│   └── user/              # manually added tools
├── config/
│   ├── default.yaml
│   └── local.yaml         # git-ignored
├── data/                  # runtime data (git-ignored)
│   ├── memory.sqlite
│   ├── temp/
│   └── pids/
├── package.json
├── turbo.json
└── tsconfig.json
```

## 15. Future Feature Backlog

Designed to plug in as new modules without modifying existing ones:

- Morning/evening briefings (daily digest per family member)
- Headless browser automation (Chromium CDP)
- PR review bot
- Shared shopping list
- Package tracking
- Usage tracking & cost reporting
- `/status` command
- Smart home control (Home Assistant / Hue)
- iMessage bridge
- Music/media control (Spotify/Sonos)
- WebChat UI
- Web page fetch & summarize
- Network monitoring
- Automatic backup orchestration
- Pairing codes for new/guest users
- Audit logging
- Multi-repo monitoring

## 16. Technology Stack

| Component | Technology |
|---|---|
| Language | TypeScript |
| Monorepo | Turborepo |
| Runtime | Node.js |
| Agent (primary) | `@anthropic-ai/claude-code` SDK |
| Agent (fallback) | Claude Code CLI (`claude -p`) |
| Database | SQLite (via better-sqlite3 or drizzle) |
| Discord | discord.js |
| Telegram | grammY |
| Event Bus | Local Redis pub/sub (upgradeable to NATS/RabbitMQ) |
| STT | Local Whisper (fallback: OpenAI/AssemblyAI) |
| Image Gen | DALL-E API (swappable) |
| Apple Integration | osascript (AppleScript/JXA) |
| Process Manager | Custom orchestrator, managed by macOS launchd |
| Config | YAML + environment variables |
