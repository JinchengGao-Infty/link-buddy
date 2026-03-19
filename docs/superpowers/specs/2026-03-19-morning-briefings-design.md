# Morning Briefings Design

## Summary

Enable CCBuddy to send a daily morning briefing to the user's Discord DM, summarizing recent conversations, flagging system issues, and pulling external data via self-evolving skills. This is implemented by fixing three gaps in the existing scheduler/cron infrastructure and adding briefing-specific configuration.

## Context

The scheduler, cron runner, proactive messaging, memory, and skill systems are all implemented (Plans 1-6). A cron job can already fire a prompt, route it through the agent, and send the response to a Discord channel. The bootstrap wrapper at `bootstrap.ts:188-191` already injects `mcpServers` (skill MCP server) and the skill nudge into all scheduler agent requests, so skills are available to cron jobs. However, three gaps prevent cron jobs from being useful for briefings:

1. **Cron jobs lack memory context** — the cron runner doesn't call `assembleContext()`, so the agent has no conversation history.
2. **Retrieval tools not exposed via MCP** — `memory_grep`, `memory_describe`, `memory_expand` are registered as external tools on the in-process SkillRegistry but not served by the MCP server (which runs as a separate process and only calls `registry.list()`).
3. **Heartbeat status not accessible to agent** — no tool or context exposes system health to the agent.

## Design

### Gap 1: Memory Context in Cron Jobs

**Files:** `packages/scheduler/src/cron-runner.ts`, `packages/scheduler/src/types.ts`, `packages/main/src/bootstrap.ts`

Add an `assembleContext` dependency to both `CronRunnerOptions` and `SchedulerDeps`:

```typescript
// The closure wraps both contextAssembler.assemble() and formatAsPrompt(),
// same pattern as the gateway at bootstrap.ts:107-109.
assembleContext: (userId: string, sessionId: string) => string;
```

In `executePromptJob()`, call `assembleContext(job.user, sessionId)` and include the result in the `AgentRequest.memoryContext` field. This makes all prompt-type cron jobs memory-aware, not just briefings.

**Session ID strategy:** The cron runner generates ephemeral session IDs (`scheduler:cron:${job.name}:${Date.now()}`). The ContextAssembler's `getFreshTail` will find zero messages for this ID (as expected — there's no conversation tail for a cron job). However, user-level summaries and profile data are keyed by `userId`, not `sessionId`, so the agent still receives conversation history summaries and user preferences. This is the desired behavior for briefings.

**Wiring in bootstrap:** Pass `assembleContext` into `SchedulerService` deps using the same closure that the gateway uses. `SchedulerService` forwards it to `CronRunner` during construction.

### Gap 2: Retrieval Tools in MCP Server

**Files:** `packages/skills/src/mcp-server.ts`, `packages/main/src/bootstrap.ts`

The MCP server runs as a separate process (spawned via stdio transport), so it cannot access the in-process SkillRegistry's external tools.

**Approach:** Add a `--memory-db <path>` flag to the MCP server. The server opens the SQLite database directly using `better-sqlite3` with `{ readonly: true }` and creates lightweight `MessageStore`, `SummaryStore`, and `RetrievalTools` instances. It does **not** call `MemoryDatabase.init()` (which runs DDL statements) — it relies on the database already existing with the correct schema (created by the main process).

The MCP server opens its own read-only file handle. SQLite WAL mode allows concurrent readers alongside the main process's writer. The MCP server must not set `pragma('journal_mode = WAL')` as that is a write operation — it simply opens and reads.

**Bootstrap wiring:** Add `'--memory-db', config.memory.db_path` to the `skillMcpServer.args` array at `bootstrap.ts:85-91`.

**New tools exposed:**
- `memory_grep` — search messages and summaries by query
- `memory_describe` — get messages in a time range with count
- `memory_expand` — expand a summary node to its sources

**Tradeoff:** This couples the MCP server to `MessageStore`/`SummaryStore` APIs. If those interfaces change, the MCP server must be updated. This is acceptable given that all packages are in the same monorepo and tested together. Creating a second MCP server for memory tools would add operational complexity without clear benefit at this scale.

### Gap 3: Heartbeat Status Tool

**Files:** `packages/scheduler/src/heartbeat.ts`, `packages/main/src/bootstrap.ts`, `packages/skills/src/mcp-server.ts`

**Status file approach:** The bootstrap subscribes to `heartbeat.status` events and writes the latest result to `data/heartbeat-status.json` using an atomic write-then-rename pattern (write to `.tmp`, then `rename`) to avoid the MCP server reading a half-written file.

**Bootstrap wiring:** Add `'--heartbeat-status-file', join(config.data_dir, 'heartbeat-status.json')` to the `skillMcpServer.args` array.

**MCP server:** When `system_health` is called, read and parse the status file. Return "no data" if the file doesn't exist, is stale (>2x heartbeat interval), or has a JSON parse error.

**New tool exposed:**
- `system_health` — returns latest heartbeat status (module statuses, system metrics, timestamp)

### Config Changes

**File:** `packages/core/src/config/schema.ts`

Add optional `timezone` to `ScheduledJobConfig`:

```typescript
interface ScheduledJobConfig {
  // ...existing fields...
  timezone?: string; // IANA timezone, overrides scheduler.timezone for this job
}
```

**File:** `packages/scheduler/src/types.ts`

Add `timezone?` to `ScheduledJob`.

**File:** `packages/scheduler/src/scheduler-service.ts`

Map `jobConfig.timezone` into the `ScheduledJob` in `registerCronJobs()`.

**File:** `packages/scheduler/src/cron-runner.ts`

Pass `job.timezone ?? this.opts.timezone` to `nodeCron.schedule()` options (currently only passes `this.opts.timezone` at line 44).

### Briefing Configuration

**File:** `config/local.yaml` (user-managed, gitignored)

```yaml
ccbuddy:
  scheduler:
    timezone: "America/Chicago"
    default_target:
      platform: discord
      channel: "1483632556522995912"
    jobs:
      morning_briefing_weekday:
        cron: "0 7 * * 1-5"
        prompt: &briefing_prompt |
          You are delivering a morning briefing to flyingchickens.

          ## Required sections:
          1. **Greeting** — brief, warm, personalized to time of day and day of week.
          2. **Conversation recap** — summarize key topics from the last 24 hours using the memory context provided and memory tools. Highlight any unresolved questions or action items.
          3. **System health** — use system_health tool. Only mention if there are failures or degraded modules. If all healthy, skip this section entirely.
          4. **Weather & calendar** — use available skills if they exist. If no skill exists for weather or calendar, create one using create_skill that fetches this data. If skill creation isn't possible right now, note what's missing and move on gracefully.

          ## Briefing preferences:
          Check the user's profile for any stored briefing preferences (additional topics to include, topics to skip). Honor those preferences.

          ## Format:
          Keep it concise — aim for a quick morning read, not a report. Use short paragraphs, not bullet-heavy walls of text.
        user: flyingchickens
      morning_briefing_weekend:
        cron: "0 8 * * 0,6"
        prompt: *briefing_prompt
        user: flyingchickens
```

Note: YAML anchors (`&briefing_prompt` / `*briefing_prompt`) avoid duplicating the prompt across both entries.

### Testing Strategy

- **CronRunner memory context:** Unit test that `assembleContext` is called with the correct userId/sessionId and the result is passed as `memoryContext` on the agent request.
- **MCP server retrieval tools:** Integration test that the MCP server exposes `memory_grep`, `memory_describe`, `memory_expand` when `--memory-db` is provided. Test tool invocation returns expected results from a seeded test database.
- **MCP server system_health:** Integration test that `system_health` reads from a status file and returns correctly, including stale-data and missing-file handling.
- **Per-job timezone:** Unit test that `node-cron` receives the job-level timezone when set, and falls back to global timezone when not.
- **Heartbeat status persistence:** Unit test that `heartbeat.status` events write to the status file atomically.
- **Read-only database:** Test that the MCP server can query the memory database without calling `init()`.

### File Change Summary

| File | Change |
|------|--------|
| `packages/scheduler/src/cron-runner.ts` | Add `assembleContext` dep, call it in `executePromptJob`, pass per-job timezone to node-cron |
| `packages/scheduler/src/types.ts` | Add `assembleContext` to `SchedulerDeps` and `CronRunnerOptions`, add `timezone?` to `ScheduledJob` |
| `packages/scheduler/src/scheduler-service.ts` | Map `jobConfig.timezone` into `ScheduledJob`, forward `assembleContext` to CronRunner |
| `packages/skills/src/mcp-server.ts` | Add `--memory-db` and `--heartbeat-status-file` flags, expose retrieval tools and `system_health` tool |
| `packages/main/src/bootstrap.ts` | Pass `assembleContext` closure to scheduler, add `--memory-db` and `--heartbeat-status-file` to MCP args, add heartbeat status file event listener with atomic writes |
| `packages/core/src/config/schema.ts` | Add `timezone?` to `ScheduledJobConfig` |
| `config/local.yaml` | Add scheduler timezone, default_target, briefing jobs with YAML anchors |

## Not In Scope

- Evening briefing (add later when morning briefing content is validated)
- Weather/calendar skill implementation (agent self-creates on first briefing run)
- Briefing history or analytics
- Custom prompt template engine
- Per-user briefing preference UI (memory-based via conversation is sufficient)
- Retry/failure notification beyond existing cron runner error handling
