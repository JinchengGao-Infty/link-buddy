# Memory Consolidation & Backup Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire up memory consolidation (DAG summarization) and backup cron jobs so the memory database self-maintains.

**Architecture:** ConsolidationService and BackupService live in `@ccbuddy/memory`, triggered by internal scheduler cron jobs. Consolidation uses an injected `summarize` closure to call the agent for summaries, keeping the memory package decoupled. The scheduler gets a new `'internal'` job type via a discriminated union refactor of `ScheduledJob`.

**Tech Stack:** TypeScript, better-sqlite3, node-cron, vitest

**Spec:** `docs/superpowers/specs/2026-03-19-memory-consolidation-backup-design.md`

---

## Chunk 1: Schema & Store Methods

### Task 1: Add `message_retention_days` to MemoryConfig

**Files:**
- Modify: `packages/core/src/config/schema.ts:19-31` (MemoryConfig interface)
- Modify: `packages/core/src/config/schema.ts:127-133` (DEFAULT_CONFIG.memory)

- [ ] **Step 1: Add `message_retention_days` to `MemoryConfig` interface**

In `packages/core/src/config/schema.ts`, add after line 30 (`max_backups: number;`):

```typescript
  message_retention_days: number;
```

- [ ] **Step 2: Add default value to `DEFAULT_CONFIG.memory`**

In the same file, after `max_backups: 7,` in the defaults:

```typescript
    message_retention_days: 30,
```

- [ ] **Step 3: Build to verify no type errors**

Run: `npm run build -w packages/core`
Expected: Clean build

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/config/schema.ts
git commit -m "feat(core): add message_retention_days to MemoryConfig"
```

---

### Task 2: Add SQLite migration columns

**Files:**
- Modify: `packages/memory/src/database.ts:10-49` (init method)
- Test: `packages/memory/src/__tests__/database.test.ts`

- [ ] **Step 1: Write failing test for migration columns**

Add to `packages/memory/src/__tests__/database.test.ts`:

```typescript
describe('schema migrations', () => {
  it('adds summarized_at column to messages table', () => {
    const cols = db.raw().pragma('table_info(messages)') as Array<{ name: string }>;
    expect(cols.some(c => c.name === 'summarized_at')).toBe(true);
  });

  it('adds condensed_at column to summary_nodes table', () => {
    const cols = db.raw().pragma('table_info(summary_nodes)') as Array<{ name: string }>;
    expect(cols.some(c => c.name === 'condensed_at')).toBe(true);
  });

  it('is idempotent — calling init() twice does not throw', () => {
    expect(() => db.init()).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/memory/src/__tests__/database.test.ts --reporter=verbose`
Expected: FAIL — `summarized_at` column not found

- [ ] **Step 3: Add migration to `init()` method**

In `packages/memory/src/database.ts`, add after the `CREATE TABLE` block (after the closing `\``);`) and before the closing brace of `init()`:

```typescript
    // Migrations — add consolidation columns if missing
    const messagesCols = this.db.pragma('table_info(messages)') as Array<{ name: string }>;
    if (!messagesCols.some(c => c.name === 'summarized_at')) {
      this.db.exec('ALTER TABLE messages ADD COLUMN summarized_at INTEGER');
    }

    const summaryCols = this.db.pragma('table_info(summary_nodes)') as Array<{ name: string }>;
    if (!summaryCols.some(c => c.name === 'condensed_at')) {
      this.db.exec('ALTER TABLE summary_nodes ADD COLUMN condensed_at INTEGER');
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/memory/src/__tests__/database.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/memory/src/database.ts packages/memory/src/__tests__/database.test.ts
git commit -m "feat(memory): add summarized_at and condensed_at migration columns"
```

---

### Task 3: Add new MessageStore methods

**Files:**
- Modify: `packages/memory/src/message-store.ts`
- Test: `packages/memory/src/__tests__/message-store.test.ts`

- [ ] **Step 1: Write failing tests for new methods**

Add to `packages/memory/src/__tests__/message-store.test.ts`:

```typescript
describe('getDistinctUserIds()', () => {
  it('returns unique user IDs', () => {
    store.add({ userId: 'u1', sessionId: 's1', platform: 'discord', content: 'a', role: 'user' });
    store.add({ userId: 'u2', sessionId: 's2', platform: 'discord', content: 'b', role: 'user' });
    store.add({ userId: 'u1', sessionId: 's3', platform: 'discord', content: 'c', role: 'user' });

    const ids = store.getDistinctUserIds();
    expect(ids).toHaveLength(2);
    expect(ids).toContain('u1');
    expect(ids).toContain('u2');
  });

  it('returns empty array when no messages', () => {
    expect(store.getDistinctUserIds()).toEqual([]);
  });
});

describe('getUnsummarizedMessages()', () => {
  it('returns unsummarized messages excluding recent N', () => {
    // Insert 5 messages
    for (let i = 0; i < 5; i++) {
      store.add({ userId: 'u1', sessionId: 's1', platform: 'discord', content: `msg-${i}`, role: 'user', timestamp: 1000 + i });
    }

    const msgs = store.getUnsummarizedMessages('u1', 2);
    expect(msgs).toHaveLength(3);
    expect(msgs[0].content).toBe('msg-0');
    expect(msgs[2].content).toBe('msg-2');
  });

  it('returns empty when all messages are within recent count', () => {
    store.add({ userId: 'u1', sessionId: 's1', platform: 'discord', content: 'a', role: 'user' });
    expect(store.getUnsummarizedMessages('u1', 5)).toEqual([]);
  });

  it('excludes already-summarized messages', () => {
    const id1 = store.add({ userId: 'u1', sessionId: 's1', platform: 'discord', content: 'old', role: 'user', timestamp: 1000 });
    store.add({ userId: 'u1', sessionId: 's1', platform: 'discord', content: 'new', role: 'user', timestamp: 2000 });

    store.markSummarized([id1], Date.now());

    const msgs = store.getUnsummarizedMessages('u1', 0);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe('new');
  });

  it('works across multiple sessions', () => {
    store.add({ userId: 'u1', sessionId: 's1', platform: 'discord', content: 'a', role: 'user', timestamp: 1000 });
    store.add({ userId: 'u1', sessionId: 's2', platform: 'discord', content: 'b', role: 'user', timestamp: 2000 });
    store.add({ userId: 'u1', sessionId: 's3', platform: 'discord', content: 'c', role: 'user', timestamp: 3000 });

    const msgs = store.getUnsummarizedMessages('u1', 1);
    expect(msgs).toHaveLength(2);
    expect(msgs[0].content).toBe('a');
    expect(msgs[1].content).toBe('b');
  });
});

describe('markSummarized()', () => {
  it('sets summarized_at on specified messages', () => {
    const id1 = store.add({ userId: 'u1', sessionId: 's1', platform: 'discord', content: 'a', role: 'user' });
    const id2 = store.add({ userId: 'u1', sessionId: 's1', platform: 'discord', content: 'b', role: 'user' });

    const now = Date.now();
    store.markSummarized([id1, id2], now);

    // Both should be excluded from unsummarized query
    const msgs = store.getUnsummarizedMessages('u1', 0);
    expect(msgs).toHaveLength(0);
  });
});

describe('pruneOldSummarized()', () => {
  it('deletes summarized messages older than threshold', () => {
    const id1 = store.add({ userId: 'u1', sessionId: 's1', platform: 'discord', content: 'old', role: 'user' });
    const id2 = store.add({ userId: 'u1', sessionId: 's1', platform: 'discord', content: 'new', role: 'user' });

    store.markSummarized([id1], 1000); // summarized long ago
    store.markSummarized([id2], Date.now()); // summarized just now

    const deleted = store.pruneOldSummarized(Date.now() - 1000);
    expect(deleted).toBe(1);
    expect(store.getById(id1)).toBeUndefined();
    expect(store.getById(id2)).toBeTruthy();
  });

  it('does not delete unsummarized messages', () => {
    const id1 = store.add({ userId: 'u1', sessionId: 's1', platform: 'discord', content: 'keep', role: 'user' });

    const deleted = store.pruneOldSummarized(Date.now());
    expect(deleted).toBe(0);
    expect(store.getById(id1)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/memory/src/__tests__/message-store.test.ts --reporter=verbose`
Expected: FAIL — methods not found

- [ ] **Step 3: Implement the new methods**

Add to `MessageStore` class in `packages/memory/src/message-store.ts`, before the `private toMessage` method:

```typescript
  getDistinctUserIds(): string[] {
    const rows = this.db.raw().prepare(
      'SELECT DISTINCT user_id FROM messages'
    ).all() as Array<{ user_id: string }>;
    return rows.map(r => r.user_id);
  }

  getUnsummarizedMessages(userId: string, excludeRecent: number): StoredMessage[] {
    const rows = this.db.raw().prepare(`
      SELECT * FROM messages
      WHERE user_id = ? AND summarized_at IS NULL
      ORDER BY timestamp ASC, id ASC
    `).all(userId) as any[];

    const cutoff = Math.max(0, rows.length - excludeRecent);
    return rows.slice(0, cutoff).map((r: any) => this.toMessage(r));
  }

  markSummarized(ids: number[], timestamp: number): void {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(',');
    this.db.raw().prepare(
      `UPDATE messages SET summarized_at = ? WHERE id IN (${placeholders})`
    ).run(timestamp, ...ids);
  }

  pruneOldSummarized(beforeTimestamp: number): number {
    const result = this.db.raw().prepare(
      'DELETE FROM messages WHERE summarized_at IS NOT NULL AND summarized_at < ?'
    ).run(beforeTimestamp);
    return result.changes;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/memory/src/__tests__/message-store.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/memory/src/message-store.ts packages/memory/src/__tests__/message-store.test.ts
git commit -m "feat(memory): add consolidation methods to MessageStore"
```

---

### Task 4: Add new SummaryStore methods

**Files:**
- Modify: `packages/memory/src/summary-store.ts`
- Test: `packages/memory/src/__tests__/summary-store.test.ts`

- [ ] **Step 1: Write failing tests for new methods**

Add to `packages/memory/src/__tests__/summary-store.test.ts`:

```typescript
describe('getUncondensedByDepth()', () => {
  it('returns nodes at given depth where condensed_at is null', () => {
    store.add({ userId: 'u1', depth: 0, content: 'summary-a', sourceIds: [1, 2], tokens: 100 });
    store.add({ userId: 'u1', depth: 0, content: 'summary-b', sourceIds: [3, 4], tokens: 100 });
    store.add({ userId: 'u1', depth: 1, content: 'condensed', sourceIds: [1], tokens: 50 });

    const nodes = store.getUncondensedByDepth('u1', 0);
    expect(nodes).toHaveLength(2);
    expect(nodes[0].content).toBe('summary-a');
    expect(nodes[1].content).toBe('summary-b');
  });

  it('excludes already-condensed nodes', () => {
    const id1 = store.add({ userId: 'u1', depth: 0, content: 'a', sourceIds: [1], tokens: 100 });
    store.add({ userId: 'u1', depth: 0, content: 'b', sourceIds: [2], tokens: 100 });

    store.markCondensed([id1], Date.now());

    const nodes = store.getUncondensedByDepth('u1', 0);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].content).toBe('b');
  });
});

describe('markCondensed()', () => {
  it('sets condensed_at on specified nodes', () => {
    const id1 = store.add({ userId: 'u1', depth: 0, content: 'a', sourceIds: [1], tokens: 100 });
    const id2 = store.add({ userId: 'u1', depth: 0, content: 'b', sourceIds: [2], tokens: 100 });

    const now = Date.now();
    store.markCondensed([id1, id2], now);

    const nodes = store.getUncondensedByDepth('u1', 0);
    expect(nodes).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/memory/src/__tests__/summary-store.test.ts --reporter=verbose`
Expected: FAIL — methods not found

- [ ] **Step 3: Implement the new methods**

Add to `SummaryStore` class in `packages/memory/src/summary-store.ts`, before the `private toNode` method:

```typescript
  getUncondensedByDepth(userId: string, depth: number): SummaryNode[] {
    const rows = this.db.raw().prepare(`
      SELECT * FROM summary_nodes
      WHERE user_id = ? AND depth = ? AND condensed_at IS NULL
      ORDER BY timestamp ASC, id ASC
    `).all(userId, depth);
    return rows.map((r: any) => this.toNode(r));
  }

  markCondensed(ids: number[], timestamp: number): void {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(',');
    this.db.raw().prepare(
      `UPDATE summary_nodes SET condensed_at = ? WHERE id IN (${placeholders})`
    ).run(timestamp, ...ids);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/memory/src/__tests__/summary-store.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/memory/src/summary-store.ts packages/memory/src/__tests__/summary-store.test.ts
git commit -m "feat(memory): add consolidation methods to SummaryStore"
```

---

## Chunk 2: ConsolidationService & BackupService

### Task 5: Add new events to EventMap

**Files:**
- Modify: `packages/core/src/types/events.ts:81-90`

- [ ] **Step 1: Add event interfaces and EventMap entries**

In `packages/core/src/types/events.ts`, add before the `EventMap` interface:

```typescript
export interface ConsolidationStats {
  userId: string;
  messagesChunked: number;
  leafNodesCreated: number;
  condensedNodesCreated: number;
  messagesPruned: number;
}

export interface BackupCompleteEvent {
  path: string;
}

export interface BackupIntegrityFailedEvent {
  path: string;
  error: string;
}
```

Then add to the `EventMap` interface:

```typescript
  'consolidation.complete': ConsolidationStats;
  'backup.complete': BackupCompleteEvent;
  'backup.integrity_failed': BackupIntegrityFailedEvent;
```

- [ ] **Step 2: Build to verify no type errors**

Run: `npm run build -w packages/core`
Expected: Clean build

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/types/events.ts
git commit -m "feat(core): add consolidation and backup events to EventMap"
```

---

### Task 6: Implement ConsolidationService

**Files:**
- Create: `packages/memory/src/consolidation-service.ts`
- Test: `packages/memory/src/__tests__/consolidation-service.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/memory/src/__tests__/consolidation-service.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { MemoryDatabase } from '../database.js';
import { MessageStore } from '../message-store.js';
import { SummaryStore } from '../summary-store.js';
import { ConsolidationService } from '../consolidation-service.js';
import type { MemoryConfig } from '@ccbuddy/core';

function makeConfig(overrides: Partial<MemoryConfig> = {}): MemoryConfig {
  return {
    db_path: '',
    max_context_tokens: 100000,
    context_threshold: 0.75,
    fresh_tail_count: 2,
    leaf_chunk_tokens: 100, // small for testing
    leaf_target_tokens: 50,
    condensed_target_tokens: 100,
    max_expand_tokens: 200,
    consolidation_cron: '0 3 * * *',
    backup_cron: '0 4 * * *',
    backup_dir: './data/backups',
    max_backups: 7,
    message_retention_days: 30,
    ...overrides,
  };
}

describe('ConsolidationService', () => {
  let tmpDir: string;
  let db: MemoryDatabase;
  let messageStore: MessageStore;
  let summaryStore: SummaryStore;
  let summarize: ReturnType<typeof vi.fn>;
  let service: ConsolidationService;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ccbuddy-consol-test-'));
    db = new MemoryDatabase(join(tmpDir, 'test.db'));
    db.init();
    messageStore = new MessageStore(db);
    summaryStore = new SummaryStore(db);
    summarize = vi.fn(async (text: string) => `Summary of: ${text.slice(0, 20)}`);
    service = new ConsolidationService({
      messageStore,
      summaryStore,
      database: db,
      config: makeConfig(),
      summarize,
    });
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('consolidate() — Phase 1: Leaf Summarization', () => {
    it('creates leaf summary nodes from old messages', async () => {
      // Add 5 messages, fresh_tail_count=2 means 3 should be summarized
      for (let i = 0; i < 5; i++) {
        messageStore.add({
          userId: 'u1', sessionId: 's1', platform: 'discord',
          content: `message-${i}`, role: 'user', timestamp: 1000 + i,
        });
      }

      const stats = await service.consolidate('u1');

      expect(stats.messagesChunked).toBe(3);
      expect(stats.leafNodesCreated).toBeGreaterThanOrEqual(1);
      expect(summarize).toHaveBeenCalled();

      // Verify summary nodes were created at depth 0
      const nodes = summaryStore.getByDepth('u1', 0);
      expect(nodes.length).toBeGreaterThanOrEqual(1);
      expect(nodes[0].depth).toBe(0);

      // Verify source messages were marked
      const remaining = messageStore.getUnsummarizedMessages('u1', 0);
      expect(remaining).toHaveLength(2); // only the fresh tail
    });

    it('does nothing when all messages are within fresh tail', async () => {
      messageStore.add({
        userId: 'u1', sessionId: 's1', platform: 'discord',
        content: 'only-one', role: 'user',
      });

      const stats = await service.consolidate('u1');
      expect(stats.messagesChunked).toBe(0);
      expect(stats.leafNodesCreated).toBe(0);
      expect(summarize).not.toHaveBeenCalled();
    });

    it('does nothing for user with no messages', async () => {
      const stats = await service.consolidate('nonexistent');
      expect(stats.messagesChunked).toBe(0);
      expect(stats.leafNodesCreated).toBe(0);
    });
  });

  describe('consolidate() — Phase 2: Multi-Level Condensation', () => {
    it('condenses 4+ depth-0 nodes into a depth-1 node', async () => {
      // Seed 4 uncondensed depth-0 nodes
      for (let i = 0; i < 4; i++) {
        summaryStore.add({
          userId: 'u1', depth: 0, content: `leaf-${i}`,
          sourceIds: [i], tokens: 20,
        });
      }

      const stats = await service.consolidate('u1');

      expect(stats.condensedNodesCreated).toBeGreaterThanOrEqual(1);
      const depth1 = summaryStore.getByDepth('u1', 1);
      expect(depth1.length).toBeGreaterThanOrEqual(1);

      // Source nodes should be marked condensed
      const uncondensed = summaryStore.getUncondensedByDepth('u1', 0);
      expect(uncondensed).toHaveLength(0);
    });

    it('does not condense when fewer than 4 nodes at a depth', async () => {
      for (let i = 0; i < 3; i++) {
        summaryStore.add({
          userId: 'u1', depth: 0, content: `leaf-${i}`,
          sourceIds: [i], tokens: 20,
        });
      }

      const stats = await service.consolidate('u1');
      expect(stats.condensedNodesCreated).toBe(0);
    });
  });

  describe('runFullConsolidation() — Retention Pruning', () => {
    it('prunes messages summarized beyond retention period', async () => {
      const retentionMs = 30 * 86400000;
      const oldTimestamp = Date.now() - retentionMs - 1000;

      const id1 = messageStore.add({
        userId: 'u1', sessionId: 's1', platform: 'discord',
        content: 'old-msg', role: 'user',
      });
      const id2 = messageStore.add({
        userId: 'u1', sessionId: 's1', platform: 'discord',
        content: 'recent-msg', role: 'user',
      });

      messageStore.markSummarized([id1], oldTimestamp);
      messageStore.markSummarized([id2], Date.now());

      const results = await service.runFullConsolidation();
      const stats = results.get('u1')!;
      expect(stats.messagesPruned).toBe(1);
      expect(messageStore.getById(id1)).toBeUndefined();
      expect(messageStore.getById(id2)).toBeTruthy();
    });
  });

  describe('runFullConsolidation()', () => {
    it('consolidates all users', async () => {
      // Add messages for 2 users, beyond fresh_tail_count
      for (let i = 0; i < 4; i++) {
        messageStore.add({
          userId: 'u1', sessionId: 's1', platform: 'discord',
          content: `u1-msg-${i}`, role: 'user', timestamp: 1000 + i,
        });
        messageStore.add({
          userId: 'u2', sessionId: 's2', platform: 'discord',
          content: `u2-msg-${i}`, role: 'user', timestamp: 1000 + i,
        });
      }

      const results = await service.runFullConsolidation();
      expect(results.size).toBe(2);
      expect(results.get('u1')!.messagesChunked).toBe(2);
      expect(results.get('u2')!.messagesChunked).toBe(2);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/memory/src/__tests__/consolidation-service.test.ts --reporter=verbose`
Expected: FAIL — module not found

- [ ] **Step 3: Implement ConsolidationService**

Create `packages/memory/src/consolidation-service.ts`:

```typescript
import { MemoryDatabase } from './database.js';
import { MessageStore } from './message-store.js';
import { SummaryStore } from './summary-store.js';
import { estimateTokens } from './token-counter.js';
import type { MemoryConfig, ConsolidationStats } from '@ccbuddy/core';

export type { ConsolidationStats };

export interface ConsolidationServiceDeps {
  messageStore: MessageStore;
  summaryStore: SummaryStore;
  database: MemoryDatabase;
  config: MemoryConfig;
  summarize: (text: string) => Promise<string>;
}

export class ConsolidationService {
  private readonly messageStore: MessageStore;
  private readonly summaryStore: SummaryStore;
  private readonly database: MemoryDatabase;
  private readonly config: MemoryConfig;
  private readonly summarize: (text: string) => Promise<string>;

  constructor(deps: ConsolidationServiceDeps) {
    this.messageStore = deps.messageStore;
    this.summaryStore = deps.summaryStore;
    this.database = deps.database;
    this.config = deps.config;
    this.summarize = deps.summarize;
  }

  async consolidate(userId: string): Promise<ConsolidationStats> {
    const stats: ConsolidationStats = {
      userId,
      messagesChunked: 0,
      leafNodesCreated: 0,
      condensedNodesCreated: 0,
      messagesPruned: 0,
    };

    // Phase 1: Leaf Summarization
    await this.leafSummarize(userId, stats);

    // Phase 2: Multi-Level Condensation
    await this.condense(userId, stats);

    return stats;
  }

  async runFullConsolidation(): Promise<Map<string, ConsolidationStats>> {
    const userIds = this.messageStore.getDistinctUserIds();
    const results = new Map<string, ConsolidationStats>();

    for (const userId of userIds) {
      const stats = await this.consolidate(userId);
      results.set(userId, stats);
    }

    // Retention pruning runs once across all users (not per-user)
    const pruned = this.pruneOldMessages();
    // Attribute pruned count to the first user's stats (or create a synthetic entry)
    if (pruned > 0 && results.size > 0) {
      const firstStats = results.values().next().value!;
      firstStats.messagesPruned = pruned;
    }

    return results;
  }

  private pruneOldMessages(): number {
    const retentionMs = this.config.message_retention_days * 86400000;
    const cutoff = Date.now() - retentionMs;
    return this.messageStore.pruneOldSummarized(cutoff);
  }

  private async leafSummarize(userId: string, stats: ConsolidationStats): Promise<void> {
    const messages = this.messageStore.getUnsummarizedMessages(userId, this.config.fresh_tail_count);
    if (messages.length === 0) return;

    // Batch into chunks by token budget
    const chunks: typeof messages[] = [];
    let currentChunk: typeof messages = [];
    let currentTokens = 0;

    for (const msg of messages) {
      if (currentTokens + msg.tokens > this.config.leaf_chunk_tokens && currentChunk.length > 0) {
        chunks.push(currentChunk);
        currentChunk = [];
        currentTokens = 0;
      }
      currentChunk.push(msg);
      currentTokens += msg.tokens;
    }
    if (currentChunk.length > 0) {
      chunks.push(currentChunk);
    }

    stats.messagesChunked = messages.length;

    for (const chunk of chunks) {
      const text = chunk.map(m => `[${m.role}] ${m.content}`).join('\n');
      const summary = await this.summarize(text);
      const sourceIds = chunk.map(m => m.id);
      const now = Date.now();

      this.database.transaction(() => {
        this.summaryStore.add({
          userId,
          depth: 0,
          content: summary,
          sourceIds,
          tokens: estimateTokens(summary),
        });
        this.messageStore.markSummarized(sourceIds, now);
      });

      stats.leafNodesCreated++;
    }
  }

  private async condense(userId: string, stats: ConsolidationStats): Promise<void> {
    let depth = 0;
    const maxDepth = 10; // safety limit

    while (depth < maxDepth) {
      const uncondensed = this.summaryStore.getUncondensedByDepth(userId, depth);
      if (uncondensed.length < 4) break;

      const text = uncondensed.map(n => n.content).join('\n\n---\n\n');
      const summary = await this.summarize(text);
      const sourceIds = uncondensed.map(n => n.id);
      const now = Date.now();

      this.database.transaction(() => {
        this.summaryStore.add({
          userId,
          depth: depth + 1,
          content: summary,
          sourceIds,
          tokens: estimateTokens(summary),
        });
        this.summaryStore.markCondensed(sourceIds, now);
      });

      stats.condensedNodesCreated++;
      depth++;
    }
  }

}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/memory/src/__tests__/consolidation-service.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/memory/src/consolidation-service.ts packages/memory/src/__tests__/consolidation-service.test.ts
git commit -m "feat(memory): implement ConsolidationService with DAG summarization"
```

---

### Task 7: Implement BackupService

**Files:**
- Create: `packages/memory/src/backup-service.ts`
- Test: `packages/memory/src/__tests__/backup-service.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/memory/src/__tests__/backup-service.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { MemoryDatabase } from '../database.js';
import { BackupService } from '../backup-service.js';
import type { EventBus } from '@ccbuddy/core';

describe('BackupService', () => {
  let tmpDir: string;
  let backupDir: string;
  let db: MemoryDatabase;
  let eventBus: EventBus;
  let service: BackupService;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ccbuddy-backup-test-'));
    backupDir = join(tmpDir, 'backups');
    db = new MemoryDatabase(join(tmpDir, 'test.db'));
    db.init();
    eventBus = {
      publish: vi.fn(async () => {}),
      subscribe: vi.fn(() => ({ dispose: vi.fn() })),
    };
    service = new BackupService({
      database: db,
      config: { backup_dir: backupDir, max_backups: 3 },
      eventBus,
    });
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('backup()', () => {
    it('creates a timestamped backup file', async () => {
      await service.backup();

      const files = readdirSync(backupDir).filter(f => f.endsWith('.sqlite'));
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/^memory-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.sqlite$/);
    });

    it('emits backup.complete event', async () => {
      await service.backup();

      expect(eventBus.publish).toHaveBeenCalledWith(
        'backup.complete',
        expect.objectContaining({ path: expect.stringContaining('memory-') }),
      );
    });
  });

  describe('rotateBackups()', () => {
    it('deletes oldest backups when exceeding max_backups', async () => {
      // Create 4 fake backup files (max is 3)
      const { mkdirSync } = await import('fs');
      mkdirSync(backupDir, { recursive: true });
      writeFileSync(join(backupDir, 'memory-2026-03-16T03-00-00.sqlite'), '');
      writeFileSync(join(backupDir, 'memory-2026-03-17T03-00-00.sqlite'), '');
      writeFileSync(join(backupDir, 'memory-2026-03-18T03-00-00.sqlite'), '');
      writeFileSync(join(backupDir, 'memory-2026-03-19T03-00-00.sqlite'), '');

      await service.rotateBackups();

      const remaining = readdirSync(backupDir).filter(f => f.endsWith('.sqlite'));
      expect(remaining).toHaveLength(3);
      expect(remaining).not.toContain('memory-2026-03-16T03-00-00.sqlite');
    });

    it('does nothing when within limit', async () => {
      const { mkdirSync } = await import('fs');
      mkdirSync(backupDir, { recursive: true });
      writeFileSync(join(backupDir, 'memory-2026-03-18T03-00-00.sqlite'), '');
      writeFileSync(join(backupDir, 'memory-2026-03-19T03-00-00.sqlite'), '');

      await service.rotateBackups();

      const remaining = readdirSync(backupDir).filter(f => f.endsWith('.sqlite'));
      expect(remaining).toHaveLength(2);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/memory/src/__tests__/backup-service.test.ts --reporter=verbose`
Expected: FAIL — module not found

- [ ] **Step 3: Implement BackupService**

Create `packages/memory/src/backup-service.ts`:

```typescript
import { mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { MemoryDatabase } from './database.js';
import type { EventBus } from '@ccbuddy/core';

export interface BackupServiceDeps {
  database: MemoryDatabase;
  config: { backup_dir: string; max_backups: number };
  eventBus: EventBus;
}

export class BackupService {
  private readonly database: MemoryDatabase;
  private readonly backupDir: string;
  private readonly maxBackups: number;
  private readonly eventBus: EventBus;

  constructor(deps: BackupServiceDeps) {
    this.database = deps.database;
    this.backupDir = deps.config.backup_dir;
    this.maxBackups = deps.config.max_backups;
    this.eventBus = deps.eventBus;
  }

  async backup(): Promise<void> {
    mkdirSync(this.backupDir, { recursive: true });

    const now = new Date();
    const timestamp = now.toISOString().replace(/:/g, '-').replace(/\.\d+Z$/, '');
    const filename = `memory-${timestamp}.sqlite`;
    const destPath = join(this.backupDir, filename);

    await this.database.backup(destPath);

    // Integrity check
    const checkDb = new Database(destPath, { readonly: true });
    try {
      const result = checkDb.pragma('integrity_check') as Array<{ integrity_check: string }>;
      const ok = result.length === 1 && result[0].integrity_check === 'ok';

      if (!ok) {
        const error = result.map(r => r.integrity_check).join('; ');
        await this.eventBus.publish('backup.integrity_failed', { path: destPath, error });
        checkDb.close();
        unlinkSync(destPath);
        return;
      }
    } finally {
      checkDb.close();
    }

    await this.eventBus.publish('backup.complete', { path: destPath });
    await this.rotateBackups();
  }

  async rotateBackups(): Promise<void> {
    let files: string[];
    try {
      files = readdirSync(this.backupDir)
        .filter(f => f.endsWith('.sqlite'))
        .sort();
    } catch {
      return; // directory doesn't exist yet
    }

    while (files.length > this.maxBackups) {
      const oldest = files.shift()!;
      unlinkSync(join(this.backupDir, oldest));
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/memory/src/__tests__/backup-service.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/memory/src/backup-service.ts packages/memory/src/__tests__/backup-service.test.ts
git commit -m "feat(memory): implement BackupService with integrity check and rotation"
```

---

### Task 8: Export new services from `@ccbuddy/memory`

**Files:**
- Modify: `packages/memory/src/index.ts`

- [ ] **Step 1: Add exports**

Add to `packages/memory/src/index.ts`:

```typescript
export { ConsolidationService, type ConsolidationStats, type ConsolidationServiceDeps } from './consolidation-service.js';
export { BackupService, type BackupServiceDeps } from './backup-service.js';
```

- [ ] **Step 2: Build to verify**

Run: `npm run build -w packages/memory`
Expected: Clean build

- [ ] **Step 3: Commit**

```bash
git add packages/memory/src/index.ts
git commit -m "feat(memory): export ConsolidationService and BackupService"
```

---

## Chunk 3: Scheduler & Bootstrap Wiring

### Task 9: Refactor ScheduledJob to discriminated union

**Files:**
- Modify: `packages/scheduler/src/types.ts`
- Modify: `packages/scheduler/src/cron-runner.ts`
- Modify: `packages/scheduler/src/scheduler-service.ts`
- Modify: `packages/scheduler/src/index.ts`
- Test: `packages/scheduler/src/__tests__/cron-runner.test.ts`

- [ ] **Step 1: Write failing test for internal job type**

Add to `packages/scheduler/src/__tests__/cron-runner.test.ts`:

```typescript
describe('internal jobs', () => {
  it('executes internal job callback', async () => {
    const callback = vi.fn(async () => {});
    const internalJobs = new Map([['cleanup', callback]]);

    const deps = createMockDeps();
    const runner = new CronRunner({ ...deps, internalJobs });

    const job: InternalJob = {
      name: 'cleanup',
      cron: '0 3 * * *',
      type: 'internal',
      enabled: true,
      nextRun: 0,
      running: false,
    };

    runner.registerJob(job);
    await runner.executeJob(job);

    expect(callback).toHaveBeenCalledOnce();
    expect(deps.eventBus.publish).toHaveBeenCalledWith(
      'scheduler.job.complete',
      expect.objectContaining({ jobName: 'cleanup', success: true }),
    );
  });

  it('logs error when internal job callback is not registered', async () => {
    const deps = createMockDeps();
    const runner = new CronRunner({ ...deps, internalJobs: new Map() });

    const job: InternalJob = {
      name: 'missing',
      cron: '0 3 * * *',
      type: 'internal',
      enabled: true,
      nextRun: 0,
      running: false,
    };

    runner.registerJob(job);
    await runner.executeJob(job);

    expect(deps.eventBus.publish).toHaveBeenCalledWith(
      'scheduler.job.complete',
      expect.objectContaining({ jobName: 'missing', success: false }),
    );
  });
});
```

Also update the existing `createMockJob` helper to return `PromptJob` explicitly:

```typescript
import type { PromptJob, InternalJob } from '../types.js';

function createMockJob(overrides: Partial<PromptJob> = {}): PromptJob {
  return {
    name: 'daily-report',
    cron: '0 9 * * *',
    type: 'prompt',
    payload: 'Give me a daily summary',
    user: 'user-123',
    target: createMockTarget(),
    permissionLevel: 'system',
    enabled: true,
    nextRun: Date.now() + 60_000,
    running: false,
    ...overrides,
  };
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/scheduler/src/__tests__/cron-runner.test.ts --reporter=verbose`
Expected: FAIL — `InternalJob` type not found

- [ ] **Step 3: Refactor types.ts to discriminated union**

Replace `ScheduledJob` in `packages/scheduler/src/types.ts`:

```typescript
export interface BaseJob {
  name: string;
  cron: string;
  enabled: boolean;
  nextRun: number;
  lastRun?: number;
  running: boolean;
  timezone?: string;
}

export interface PromptJob extends BaseJob {
  type: 'prompt';
  payload: string;
  user: string;
  target: MessageTarget;
  permissionLevel: 'admin' | 'system';
}

export interface SkillJob extends BaseJob {
  type: 'skill';
  payload: string;
  user: string;
  target: MessageTarget;
  permissionLevel: 'admin' | 'system';
}

export interface InternalJob extends BaseJob {
  type: 'internal';
}

export type ScheduledJob = PromptJob | SkillJob | InternalJob;
```

Add to `SchedulerDeps`:

```typescript
  internalJobs?: Map<string, () => Promise<void>>;
```

- [ ] **Step 4: Update CronRunner to handle internal jobs**

In `packages/scheduler/src/cron-runner.ts`, add `internalJobs` to `CronRunnerOptions`:

```typescript
  internalJobs?: Map<string, () => Promise<void>>;
```

Update `executeJob` method:

```typescript
  async executeJob(job: ScheduledJob): Promise<void> {
    if (job.running) return;

    job.running = true;
    try {
      if (job.type === 'internal') {
        await this.executeInternalJob(job);
      } else if (job.type === 'skill') {
        await this.executeSkillJob(job);
      } else {
        await this.executePromptJob(job);
      }
    } finally {
      job.running = false;
    }
  }
```

Also narrow the existing method signatures:
- `executePromptJob(job: ScheduledJob)` → `executePromptJob(job: PromptJob)`
- `executeSkillJob(job: ScheduledJob)` → `executeSkillJob(job: SkillJob)`
- `handleError(job: ScheduledJob, ...)` → `handleError(job: PromptJob | SkillJob, ...)`
- `publishComplete(job: ScheduledJob, ...)` → `publishComplete(job: PromptJob | SkillJob, ...)`

Add the necessary type imports at the top of `cron-runner.ts`:
```typescript
import type { ScheduledJob, PromptJob, SkillJob, InternalJob } from './types.js';
```

Add new method:

```typescript
  private async executeInternalJob(job: InternalJob): Promise<void> {
    const callback = this.opts.internalJobs?.get(job.name);
    if (!callback) {
      console.error(`[Scheduler] Internal job "${job.name}" has no registered callback`);
      await this.opts.eventBus.publish('scheduler.job.complete', {
        jobName: job.name,
        source: 'cron' as const,
        success: false,
        target: { platform: 'system', channel: 'internal' },
        timestamp: Date.now(),
      });
      return;
    }

    try {
      await callback();
      await this.opts.eventBus.publish('scheduler.job.complete', {
        jobName: job.name,
        source: 'cron' as const,
        success: true,
        target: { platform: 'system', channel: 'internal' },
        timestamp: Date.now(),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[Scheduler] Internal job "${job.name}" failed:`, message);
      await this.opts.eventBus.publish('scheduler.job.complete', {
        jobName: job.name,
        source: 'cron' as const,
        success: false,
        target: { platform: 'system', channel: 'internal' },
        timestamp: Date.now(),
      });
    }
  }
```

Update `executePromptJob` and `executeSkillJob` signatures to use the narrower types if needed (they already access `job.user`, `job.target`, `job.payload` which exist on `PromptJob | SkillJob`).

- [ ] **Step 5: Update SchedulerService to pass internalJobs through**

In `packages/scheduler/src/scheduler-service.ts`, update the `CronRunner` constructor call to pass through `internalJobs`:

```typescript
    this.cronRunner = new CronRunner({
      eventBus: deps.eventBus,
      executeAgentRequest: deps.executeAgentRequest,
      sendProactiveMessage: deps.sendProactiveMessage,
      runSkill: deps.runSkill,
      timezone: deps.config.scheduler.timezone,
      assembleContext: deps.assembleContext,
      internalJobs: deps.internalJobs,
    });
```

- [ ] **Step 6: Update index.ts exports**

In `packages/scheduler/src/index.ts`, add to the type exports:

```typescript
export type {
  ScheduledJob,
  BaseJob,
  PromptJob,
  SkillJob,
  InternalJob,
  TriggerResult,
  HealthCheckResult,
  SchedulerDeps,
  MessageTarget,
} from './types.js';
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run packages/scheduler/src/__tests__/ --reporter=verbose`
Expected: PASS (all scheduler tests, including existing ones — the discriminated union is backward compatible for prompt/skill jobs since `createMockJob` sets `type: 'prompt'`)

- [ ] **Step 8: Commit**

```bash
git add packages/scheduler/src/types.ts packages/scheduler/src/cron-runner.ts packages/scheduler/src/scheduler-service.ts packages/scheduler/src/index.ts packages/scheduler/src/__tests__/cron-runner.test.ts
git commit -m "feat(scheduler): add internal job type via discriminated union refactor"
```

---

### Task 10: Wire consolidation and backup into bootstrap

**Files:**
- Modify: `packages/main/src/bootstrap.ts`

- [ ] **Step 1: Add imports**

Add to the `@ccbuddy/memory` import in `packages/main/src/bootstrap.ts`:

```typescript
import {
  MemoryDatabase,
  MessageStore,
  SummaryStore,
  ProfileStore,
  ContextAssembler,
  RetrievalTools,
  ConsolidationService,
  BackupService,
} from '@ccbuddy/memory';
```

- [ ] **Step 2: Create services after memory stores**

After the `retrievalTools` creation (around line 42) and before the SkillRegistry section, add:

```typescript
  // 6b. Create consolidation and backup services
  const summarize = async (text: string): Promise<string> => {
    const sessionId = `consolidation:${Date.now()}`;
    const request: import('@ccbuddy/core').AgentRequest = {
      prompt: text,
      userId: 'system',
      sessionId,
      channelId: 'internal',
      platform: 'system',
      permissionLevel: 'system',
      systemPrompt: 'You are a summarization engine. Summarize the following conversation preserving key facts, decisions, user preferences, and important context. Be concise but thorough. Output only the summary, no preamble.',
    };

    const generator = agentService.handleRequest(request);
    let result = '';
    for await (const event of generator) {
      if (event.type === 'complete') {
        result = event.response;
        break;
      }
      if (event.type === 'error') {
        throw new Error(`Summarization failed: ${event.error}`);
      }
    }
    return result;
  };

  const consolidationService = new ConsolidationService({
    messageStore,
    summaryStore,
    database,
    config: config.memory,
    summarize,
  });

  const backupService = new BackupService({
    database,
    config: config.memory,
    eventBus,
  });
```

- [ ] **Step 3: Create internal jobs map and pass to scheduler**

Before the `SchedulerService` creation, add:

```typescript
  const internalJobs = new Map<string, () => Promise<void>>([
    ['memory_consolidation', async () => {
      const results = await consolidationService.runFullConsolidation();
      for (const [userId, stats] of results) {
        await eventBus.publish('consolidation.complete', stats);
      }
    }],
    ['memory_backup', () => backupService.backup()],
  ]);
```

Then add `internalJobs` to the `SchedulerService` constructor call:

```typescript
  const schedulerService = new SchedulerService({
    config,
    eventBus,
    executeAgentRequest: (request) => agentService.handleRequest({
      ...request,
      mcpServers: [skillMcpServer],
      systemPrompt: [request.systemPrompt, skillNudge].filter(Boolean).join('\n\n'),
    }),
    sendProactiveMessage,
    runSkill: undefined,
    assembleContext: (userId, sessionId) => {
      const context = contextAssembler.assemble(userId, sessionId);
      return contextAssembler.formatAsPrompt(context);
    },
    checkDatabase: async () => {
      messageStore.getById(0);
      return true;
    },
    checkAgent: async () => {
      const start = Date.now();
      const { execFile } = await import('node:child_process');
      return new Promise<{ reachable: boolean; durationMs: number }>((resolve) => {
        execFile('claude', ['--version'], { timeout: 10_000 }, (err) => {
          resolve({ reachable: !err, durationMs: Date.now() - start });
        });
      });
    },
    internalJobs,
  });
```

- [ ] **Step 4: Add internal jobs to scheduler config in default.yaml or registerCronJobs**

The internal jobs need to be registered in `SchedulerService.registerCronJobs()`. Update `packages/scheduler/src/scheduler-service.ts` to also register internal jobs from the `internalJobs` map:

Add a new method to `SchedulerService`:

```typescript
  private registerInternalJobs(): void {
    if (!this.deps.internalJobs) return;

    // Register memory_consolidation if config has a cron
    const memConfig = this.deps.config.memory;

    if (memConfig.consolidation_cron) {
      const job: import('./types.js').InternalJob = {
        name: 'memory_consolidation',
        cron: memConfig.consolidation_cron,
        type: 'internal',
        enabled: true,
        nextRun: 0,
        running: false,
        timezone: this.deps.config.scheduler.timezone,
      };
      this.jobs.push(job);
      this.cronRunner.registerJob(job);
    }

    if (memConfig.backup_cron) {
      const job: import('./types.js').InternalJob = {
        name: 'memory_backup',
        cron: memConfig.backup_cron,
        type: 'internal',
        enabled: true,
        nextRun: 0,
        running: false,
        timezone: this.deps.config.scheduler.timezone,
      };
      this.jobs.push(job);
      this.cronRunner.registerJob(job);
    }
  }
```

Call it from `start()`:

```typescript
  async start(): Promise<void> {
    this.registerCronJobs();
    this.registerInternalJobs();
    this.startHeartbeat();
    await this.startWebhooks();
    console.log('[Scheduler] Started');
  }
```

- [ ] **Step 5: Build the full project to verify**

Run: `npm run build`
Expected: Clean build across all packages

- [ ] **Step 6: Run all tests**

Run: `npm test`
Expected: All tests pass (existing + new)

- [ ] **Step 7: Commit**

```bash
git add packages/main/src/bootstrap.ts packages/scheduler/src/scheduler-service.ts
git commit -m "feat(main): wire consolidation and backup services into bootstrap and scheduler"
```

---

### Task 11: Final integration verification

- [ ] **Step 1: Run full test suite**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 2: Build all packages**

Run: `npm run build`
Expected: Clean build

- [ ] **Step 3: Verify config loads with new field**

Run: `node -e "const { loadConfig } = require('@ccbuddy/core'); const c = loadConfig('./config'); console.log('retention_days:', c.memory.message_retention_days);"`
Expected: `retention_days: 30`

- [ ] **Step 4: Commit any remaining changes and tag**

```bash
git add -A
git status  # verify nothing unexpected
git commit -m "feat: memory consolidation and backup — complete implementation"
```
