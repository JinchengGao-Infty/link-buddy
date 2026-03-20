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
    leaf_chunk_tokens: 100,
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

      const nodes = summaryStore.getByDepth('u1', 0);
      expect(nodes.length).toBeGreaterThanOrEqual(1);
      expect(nodes[0].depth).toBe(0);

      const remaining = messageStore.getUnsummarizedMessages('u1', 0);
      expect(remaining).toHaveLength(2);
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

    it('chunks large batches of uncondensed nodes by condensed_target_tokens', async () => {
      // condensed_target_tokens = 100; each node is 60 tokens, so 60 + 60 = 120 > 100
      // means each chunk holds exactly 1 node. 6 depth-0 nodes → 6 depth-1 nodes.
      // The 6 depth-1 nodes then condense further (6 >= 4 threshold), producing
      // at least 1 depth-2 node. Total condensedNodesCreated >= 7.
      const cfg = makeConfig({ condensed_target_tokens: 100 });
      const svc = new ConsolidationService({
        messageStore,
        summaryStore,
        database: db,
        config: cfg,
        summarize,
      });

      for (let i = 0; i < 6; i++) {
        summaryStore.add({
          userId: 'u2', depth: 0, content: `leaf-${i}`,
          sourceIds: [100 + i], tokens: 60,
        });
      }

      const stats = await svc.consolidate('u2');

      // 6 depth-0 chunks each produce one depth-1 node
      const depth1 = summaryStore.getByDepth('u2', 1);
      expect(depth1).toHaveLength(6);

      // All depth-0 nodes must be marked condensed
      const remaining = summaryStore.getUncondensedByDepth('u2', 0);
      expect(remaining).toHaveLength(0);

      // condensedNodesCreated is at least 6 (from depth-0 chunking),
      // plus however many higher-level nodes the cascade produces
      expect(stats.condensedNodesCreated).toBeGreaterThanOrEqual(6);

      // summarize was called at least once per depth-0 chunk
      expect(summarize.mock.calls.length).toBeGreaterThanOrEqual(6);
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
