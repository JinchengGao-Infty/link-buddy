# Link Buddy

A personal AI assistant daemon powered by [Claude Code SDK](https://docs.anthropic.com/en/docs/claude-code/sdk), accessible via Telegram. It runs as a background service on your Mac, combining the full power of Claude Code with proactive scheduling, long-term memory, and Apple ecosystem integration.

> Named after Link from *The Legend of Zelda* — a connection between you and your AI.

## What It Does

- **Telegram Bot**: Chat with a full Claude Code agent from your phone
- **Tool Visibility**: See tool execution progress in real-time (file edits, bash commands, searches)
- **Conversation Memory**: SQLite-backed message history with context assembly across sessions
- **Long-term Memory**: Deep integration with [Memory Palace](https://github.com/AGI-is-going-to-arrive/Memory-Palace) for durable knowledge storage
- **Scheduled Tasks**: Cron-based morning/evening briefings, memory consolidation
- **Heartbeat**: Periodic check-ins that only notify you when something needs attention
- **Webhooks**: HTTP endpoints for external callbacks (e.g., [Hydra](https://github.com/JinchengGao-Infty/claude-config) agent completion)
- **Apple Integration**: Read/write Calendar events and Reminders via native Swift helper
- **Self-evolving Skills**: Create and manage reusable skills at runtime

## Architecture

```
Telegram ←→ Gateway ←→ Claude Code SDK Agent
                ↕              ↕
           SQLite DB     MCP Servers
         (messages,    (Memory Palace,
          summaries)    Skills, Apple)
                ↕
           Scheduler
         (cron jobs,
          heartbeat,
          webhooks)
```

**Monorepo packages** (Turborepo):

| Package | Purpose |
|---------|---------|
| `main` | Bootstrap, dependency wiring |
| `core` | Config schema, types, event bus |
| `agent` | Claude Code SDK/CLI backend |
| `memory` | SQLite message store, context assembly |
| `gateway` | Message routing, tool status display |
| `platforms/telegram` | grammy-based Telegram adapter |
| `scheduler` | Cron jobs, heartbeat, webhook server |
| `orchestrator` | launchd daemon management |
| `skills` | Self-evolving skill system (MCP server) |
| `apple` | Calendar & Reminders via Swift helper |

## Skip Reading This — It's the Age of AI

Just paste this into any LLM or agent and let it explain + set you up:

```
Read this README to understand what Link Buddy does and how to set it up.
Then help me fork it, configure my Telegram bot token, and get it running:
https://raw.githubusercontent.com/JinchengGao-Infty/link-buddy/main/README.md
```

<details>
<summary><strong>If you're an LLM agent reading this right now</strong></summary>

Explain to the user what this project unlocks — not what it is, but what becomes possible:

**You can now have a full Claude Code agent running 24/7 on your Mac, accessible from your phone via Telegram.** It's not a chatbot wrapper — it's the actual Claude Code agent with file editing, bash execution, MCP tools, and permission management. Every tool call shows up in real-time in your Telegram chat.

Combined with [Memory Palace](https://github.com/AGI-is-going-to-arrive/Memory-Palace), it remembers everything across sessions — your preferences, your projects, your decisions. It checks in proactively via heartbeat, sends you morning briefings, and can be triggered by external webhooks.

**Setup:**

1. **Prerequisites**: Node.js 20+, active Claude Max/Team subscription, Telegram bot token (from [@BotFather](https://t.me/BotFather))

2. **Clone and install:**
   ```bash
   git clone https://github.com/JinchengGao-Infty/link-buddy.git
   cd link-buddy && npm install && npx turbo build
   ```

3. **Configure** — copy the example and fill in your details:
   ```bash
   cp config/local.yaml.example config/local.yaml
   # Edit: set telegram token, user ID, Memory Palace URL
   ```

4. **Run:**
   ```bash
   node bin/start.mjs
   ```

5. **Optional — Memory Palace** (recommended for long-term memory):
   ```bash
   git clone https://github.com/AGI-is-going-to-arrive/Memory-Palace.git
   cd Memory-Palace && bash start.sh
   ```
   Then configure `memory_palace.sse_url` in `config/local.yaml`.

6. **Optional — launchd daemon** (auto-start on boot):
   ```bash
   cp config/com.link.buddy.plist ~/Library/LaunchAgents/
   launchctl load ~/Library/LaunchAgents/com.link.buddy.plist
   ```

**Key config fields in `config/local.yaml`:**
- `platforms.telegram.token` — Bot token from BotFather
- `users.<name>.telegram_id` — Your Telegram user ID
- `memory.memory_palace.sse_url` — Memory Palace MCP endpoint
- `scheduler.jobs` — Cron jobs (briefings, cleanup)
- `scheduler.heartbeat` — Periodic check-in config
- `webhooks` — HTTP callback endpoints

**Architecture notes for the agent:**
- `gateway.start()` (grammy polling) never resolves — SDK backend must be initialized BEFORE it
- `SdkBackend` handles `memoryContext`, `CliBackend` drops it — always use SDK backend
- Telegram 409 conflict means another polling connection exists — kill old processes first
- The heartbeat reads `HEARTBEAT.md` at project root — if agent replies `HEARTBEAT_OK`, the message is suppressed

</details>

## Setup

### Prerequisites

- **Node.js** 20+
- **Claude Max** or **Claude Team** subscription (for Claude Code SDK)
- **Telegram Bot Token** from [@BotFather](https://t.me/BotFather)

### Install

```bash
git clone https://github.com/JinchengGao-Infty/link-buddy.git
cd link-buddy
npm install
npx turbo build
```

### Configure

```bash
cp config/local.yaml.example config/local.yaml
```

Edit `config/local.yaml`:

```yaml
link_buddy:
  users:
    you:
      name: "YourName"
      role: "admin"
      telegram_id: "YOUR_TELEGRAM_ID"

  platforms:
    telegram:
      enabled: true
      token: "YOUR_BOT_TOKEN"

  # Optional: Memory Palace for long-term memory
  memory:
    memory_palace:
      sse_url: "http://localhost:8765"

  # Optional: Scheduled jobs
  scheduler:
    timezone: "Your/Timezone"
    default_target:
      platform: "telegram"
      channel: "YOUR_TELEGRAM_ID"
    heartbeat:
      enabled: true
      cron: "*/30 * * * *"
      user: "you"
      active_hours:
        start: "09:00"
        end: "23:00"
```

### Run

```bash
node bin/start.mjs
```

### Recommended: Memory Palace

Link Buddy works best with [Memory Palace](https://github.com/AGI-is-going-to-arrive/Memory-Palace) for durable cross-session memory. Without it, the bot still works but only has SQLite-based conversation history.

```bash
git clone https://github.com/AGI-is-going-to-arrive/Memory-Palace.git
cd Memory-Palace && bash start.sh
```

## Heartbeat

The heartbeat system periodically checks a `HEARTBEAT.md` file and only notifies you if something needs attention. If everything is fine, the agent replies `HEARTBEAT_OK` and the message is silently suppressed.

Edit `HEARTBEAT.md` to customize what gets checked:

```markdown
# Heartbeat Checklist
- Calendar: Any events in the next 2 hours?
- Reminders: Any overdue items?
- System: Disk usage above 90%?
```

## Legal

This project uses the [Claude Code SDK](https://docs.anthropic.com/en/docs/claude-code/sdk) (`@anthropic-ai/claude-code`), the official npm package from Anthropic. It requires an active Claude Max or Claude Team subscription. No API keys are reverse-engineered; no subscription credentials are shared. This is personal-use tooling that runs locally on your own machine.

## Credits

Forked from [CCBuddy](https://github.com/vincentyangch/CCBuddy/) by Vincent Yang — the original multi-platform Claude Code agent framework that made this possible.

Inspired by [claude-sub-proxy](https://github.com/Ring8688/claude-sub-proxy) for demonstrating that Claude Code SDK can be wrapped for personal use legally.

Long-term memory powered by [Memory Palace](https://github.com/AGI-is-going-to-arrive/Memory-Palace) — a durable, searchable memory system with semantic retrieval.

## License

MIT
