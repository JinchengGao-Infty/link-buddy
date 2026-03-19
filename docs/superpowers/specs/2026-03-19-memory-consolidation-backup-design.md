# Memory Consolidation & Backup Design

## Overview

Wire up the already-configured but unimplemented memory consolidation and backup cron jobs. Consolidation compacts old messages into the existing DAG summary hierarchy using agent-powered summarization. Backup creates timestamped SQLite snapshots with integrity verification.

## Config Schema

One new field added to `memory` config:

```typescript
memory: {
  // existing fields used by this feature:
  consolidation_cron: '0 3 * * *',
  backup_cron: '0 4 * * *',
  backup_dir: './data/backups',
  max_backups: 7,
  leaf_chunk_tokens: 20000,
  leaf_target_tokens: 1200,
  condensed_target_tokens: 2000,
  max_expand_tokens: 4000,
  fresh_tail_count: 32,

  // new:
  message_retention_days: 30,  // keep raw messages this long after summarization
}
```

## ConsolidationService

**Package:** `@ccbuddy/memory`

**Constructor dependencies:**
- `MessageStore` — message data access
- `SummaryStore` — summary node data access
- `MemoryDatabase` — transactions
- `config.memory` — thresholds and retention config
- `summarize: (text: string) => Promise<string>` — injected closure that calls the agent to produce a summary (keeps memory package decoupled from agent)

### `consolidate(userId: string): Promise<ConsolidationStats>`

Three-phase process:

#### Phase 1: Leaf Summarization

1. Find messages for the user that have `summarized_at IS NULL`, excluding the most recent `fresh_tail_count` messages (never touch the active conversation tail)
2. Batch messages into chunks of ~`leaf_chunk_tokens` tokens each
3. For each chunk:
   - Call `summarize()` with a prompt: "Summarize this conversation preserving key facts, decisions, and user preferences"
   - Insert result as a depth-0 summary node with `source_ids` = original message IDs
   - Set `summarized_at = Date.now()` on the source messages
4. Wrap each chunk's insert + update in a transaction for atomicity

#### Phase 2: Multi-Level Condensation

1. Starting at depth 0, iterate upward:
   - Count nodes at this depth where `condensed_at IS NULL`
   - If 4+ uncondensed nodes exist at this depth:
     - Batch them and call `summarize()` to produce a condensed summary
     - Insert result as depth+1 node with `source_ids` = source node IDs
     - Set `condensed_at = Date.now()` on source nodes
   - Repeat until no level has 4+ uncondensed nodes

#### Phase 3: Retention Pruning

1. Delete messages where:
   - `summarized_at IS NOT NULL`
   - `summarized_at < Date.now() - (message_retention_days * 86400000)`
2. This preserves `memory_expand` capability for recent history while bounding database growth

### `runFullConsolidation(): Promise<Map<string, ConsolidationStats>>`

Gets all distinct user IDs from MessageStore, runs `consolidate()` for each. Returns stats per user.

### `ConsolidationStats`

```typescript
interface ConsolidationStats {
  userId: string;
  messagesChunked: number;
  leafNodesCreated: number;
  condensedNodesCreated: number;
  messagesPruned: number;
}
```

## BackupService

**Package:** `@ccbuddy/memory`

**Constructor dependencies:**
- `MemoryDatabase` — for `database.backup()`
- `config.memory` — for `backup_dir` and `max_backups`
- `eventBus: EventBus` — for integrity failure alerts

### `backup(): Promise<void>`

1. Ensure `backup_dir` exists (`mkdir -p`)
2. Generate filename: `memory-YYYY-MM-DDTHH-MM-SS.sqlite`
3. Call `database.backup(destPath)`
4. Open the backup file read-only with better-sqlite3
5. Run `PRAGMA integrity_check`
6. Close the backup database
7. If integrity check fails, emit `backup.integrity_failed` event with details
8. Call `rotateBackups()`

### `rotateBackups(): Promise<void>`

1. List `*.sqlite` files in `backup_dir`, sorted alphabetically (timestamp naming = chronological)
2. If count > `max_backups`, delete the oldest excess files

## SQLite Schema Changes

Migration-style additions in `MemoryDatabase` (check column existence before adding):

```sql
ALTER TABLE messages ADD COLUMN summarized_at INTEGER;
ALTER TABLE summary_nodes ADD COLUMN condensed_at INTEGER;
```

## Scheduler Integration

### New Job Type

Add `'internal'` to the `ScheduledJob.type` union:

```typescript
type: 'prompt' | 'skill' | 'internal';
```

Internal jobs store a callback reference instead of a prompt payload.

### CronRunner Changes

When `job.type === 'internal'`:
- Execute the registered callback directly
- No agent session, no proactive message
- Log success/failure
- Emit `scheduler.job.complete` event

### SchedulerDeps Addition

```typescript
interface SchedulerDeps {
  // ... existing ...
  internalJobs?: Map<string, () => Promise<void>>;
}
```

## Bootstrap Wiring

In `packages/main/src/bootstrap.ts`, after memory stores are initialized:

1. Create `ConsolidationService` with stores, database, config, and a `summarize` closure:
   ```typescript
   const summarize = async (text: string): Promise<string> => {
     // Call executeAgentRequest with summarization system prompt
     // Collect text chunks from the async generator
     // Return concatenated summary text
   };
   ```

2. Create `BackupService` with database, config, eventBus

3. Register internal scheduler jobs:
   - `memory_consolidation`: cron from `config.memory.consolidation_cron`, callback = `consolidationService.runFullConsolidation()`
   - `memory_backup`: cron from `config.memory.backup_cron`, callback = `backupService.backup()`

## Events

| Event | Payload | When |
|-------|---------|------|
| `consolidation.complete` | `ConsolidationStats` | After each user's consolidation |
| `backup.complete` | `{ path: string }` | After successful backup |
| `backup.integrity_failed` | `{ path: string, error: string }` | If PRAGMA integrity_check fails |

## Testing Strategy

### ConsolidationService (unit)
- Leaf summarization: messages chunked by token budget, `summarize` called per chunk, depth-0 nodes created with correct `source_ids`, messages marked with `summarized_at`
- Multi-level condensation: seed depth-0 nodes, depth-1 nodes created when 4+ threshold met, `condensed_at` set on sources
- Retention pruning: old summarized messages deleted, unsummarized untouched, recently-summarized kept
- Edge cases: no messages, only fresh tail, single message below chunk threshold

### BackupService (unit)
- Creates timestamped file in correct directory
- Rotation deletes oldest when exceeding `max_backups`
- Integrity failure emits event but doesn't throw

### Integration
- Full `consolidate()` with real SQLite and mock summarizer
- `runFullConsolidation()` across multiple users
- Backup + rotate with real filesystem (temp dir)

### Scheduler
- Internal job type executes callback on cron trigger
- Internal job emits `scheduler.job.complete` event
