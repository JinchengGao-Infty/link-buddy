import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { MemoryDatabase } from '../database.js';
import { SummaryStore } from '../summary-store.js';

describe('SummaryStore', () => {
  let tmpDir: string;
  let db: MemoryDatabase;
  let store: SummaryStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ccbuddy-ss-test-'));
    db = new MemoryDatabase(join(tmpDir, 'test.db'));
    db.init();
    store = new SummaryStore(db);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('add() and getById()', () => {
    it('creates a leaf node (depth 0) with source message IDs', () => {
      const id = store.add({
        userId: 'u1',
        depth: 0,
        content: 'Summary of messages 1, 2, 3',
        sourceIds: [1, 2, 3],
        tokens: 15,
      });

      expect(id).toBeGreaterThan(0);

      const node = store.getById(id);
      expect(node).toBeTruthy();
      expect(node!.userId).toBe('u1');
      expect(node!.depth).toBe(0);
      expect(node!.content).toBe('Summary of messages 1, 2, 3');
      expect(node!.sourceIds).toEqual([1, 2, 3]);
      expect(node!.tokens).toBe(15);
    });

    it('creates a condensed node (depth 1) from leaf summary IDs', () => {
      const leafId1 = store.add({
        userId: 'u1',
        depth: 0,
        content: 'Leaf summary A',
        sourceIds: [1, 2],
        tokens: 10,
      });
      const leafId2 = store.add({
        userId: 'u1',
        depth: 0,
        content: 'Leaf summary B',
        sourceIds: [3, 4],
        tokens: 10,
      });

      const condensedId = store.add({
        userId: 'u1',
        depth: 1,
        content: 'Condensed summary of leaves',
        sourceIds: [leafId1, leafId2],
        tokens: 20,
      });

      const node = store.getById(condensedId);
      expect(node).toBeTruthy();
      expect(node!.depth).toBe(1);
      expect(node!.sourceIds).toEqual([leafId1, leafId2]);
    });

    it('auto-sets timestamp when not provided', () => {
      const before = Date.now();
      const id = store.add({
        userId: 'u1',
        depth: 0,
        content: 'test',
        sourceIds: [],
        tokens: 5,
      });
      const after = Date.now();
      const node = store.getById(id);
      expect(node!.timestamp).toBeGreaterThanOrEqual(before);
      expect(node!.timestamp).toBeLessThanOrEqual(after);
    });

    it('uses provided timestamp', () => {
      const ts = 1700000000000;
      const id = store.add({
        userId: 'u1',
        depth: 0,
        content: 'test',
        sourceIds: [1],
        tokens: 5,
        timestamp: ts,
      });
      const node = store.getById(id);
      expect(node!.timestamp).toBe(ts);
    });

    it('returns undefined for non-existent id', () => {
      expect(store.getById(9999)).toBeUndefined();
    });
  });

  describe('getByDepth()', () => {
    it('returns all nodes at a given depth in chronological order', () => {
      const base = Date.now();
      store.add({ userId: 'u1', depth: 0, content: 'leaf A', sourceIds: [1], tokens: 5, timestamp: base });
      store.add({ userId: 'u1', depth: 1, content: 'condensed X', sourceIds: [10], tokens: 10, timestamp: base + 1 });
      store.add({ userId: 'u1', depth: 0, content: 'leaf B', sourceIds: [2], tokens: 5, timestamp: base + 2 });

      const leaves = store.getByDepth('u1', 0);
      expect(leaves).toHaveLength(2);
      expect(leaves[0].content).toBe('leaf A');
      expect(leaves[1].content).toBe('leaf B');

      const condensed = store.getByDepth('u1', 1);
      expect(condensed).toHaveLength(1);
      expect(condensed[0].content).toBe('condensed X');
    });

    it('returns empty array when no nodes at depth', () => {
      store.add({ userId: 'u1', depth: 0, content: 'leaf', sourceIds: [], tokens: 5 });
      expect(store.getByDepth('u1', 1)).toHaveLength(0);
    });
  });

  describe('getRecent()', () => {
    it('returns most recent N nodes across all depths in chronological order', () => {
      const base = Date.now();
      store.add({ userId: 'u1', depth: 0, content: 'first', sourceIds: [], tokens: 5, timestamp: base });
      store.add({ userId: 'u1', depth: 1, content: 'second', sourceIds: [], tokens: 5, timestamp: base + 1 });
      store.add({ userId: 'u1', depth: 0, content: 'third', sourceIds: [], tokens: 5, timestamp: base + 2 });
      store.add({ userId: 'u1', depth: 2, content: 'fourth', sourceIds: [], tokens: 5, timestamp: base + 3 });

      const recent = store.getRecent('u1', 2);
      expect(recent).toHaveLength(2);
      expect(recent[0].content).toBe('third');
      expect(recent[1].content).toBe('fourth');
    });

    it('returns all nodes when limit exceeds count', () => {
      store.add({ userId: 'u1', depth: 0, content: 'only one', sourceIds: [], tokens: 5 });
      expect(store.getRecent('u1', 10)).toHaveLength(1);
    });
  });

  describe('user isolation', () => {
    it('getByDepth does not return nodes from other users', () => {
      store.add({ userId: 'u1', depth: 0, content: 'u1 node', sourceIds: [], tokens: 5 });
      store.add({ userId: 'u2', depth: 0, content: 'u2 node', sourceIds: [], tokens: 5 });

      const nodes = store.getByDepth('u1', 0);
      expect(nodes).toHaveLength(1);
      expect(nodes[0].userId).toBe('u1');
    });

    it('getRecent does not return nodes from other users', () => {
      store.add({ userId: 'u1', depth: 0, content: 'u1 node', sourceIds: [], tokens: 5 });
      store.add({ userId: 'u2', depth: 0, content: 'u2 node', sourceIds: [], tokens: 5 });

      const nodes = store.getRecent('u1', 10);
      expect(nodes).toHaveLength(1);
      expect(nodes[0].userId).toBe('u1');
    });
  });

  describe('search()', () => {
    it('finds nodes matching content query', () => {
      store.add({ userId: 'u1', depth: 0, content: 'user asked about cats', sourceIds: [], tokens: 5 });
      store.add({ userId: 'u1', depth: 0, content: 'user asked about dogs', sourceIds: [], tokens: 5 });
      store.add({ userId: 'u1', depth: 1, content: 'summary about cats and preferences', sourceIds: [], tokens: 10 });

      const results = store.search('u1', 'cats');
      expect(results).toHaveLength(2);
      expect(results.every(n => n.content.includes('cats'))).toBe(true);
    });

    it('does not return results from other users', () => {
      store.add({ userId: 'u1', depth: 0, content: 'u1 cats', sourceIds: [], tokens: 5 });
      store.add({ userId: 'u2', depth: 0, content: 'u2 cats', sourceIds: [], tokens: 5 });

      const results = store.search('u1', 'cats');
      expect(results).toHaveLength(1);
      expect(results[0].userId).toBe('u1');
    });
  });

  describe('getTotalTokens()', () => {
    it('sums tokens for all nodes by user', () => {
      store.add({ userId: 'u1', depth: 0, content: 'a', sourceIds: [], tokens: 10 });
      store.add({ userId: 'u1', depth: 1, content: 'b', sourceIds: [], tokens: 25 });
      store.add({ userId: 'u2', depth: 0, content: 'c', sourceIds: [], tokens: 100 });

      expect(store.getTotalTokens('u1')).toBe(35);
    });

    it('returns 0 when user has no nodes', () => {
      expect(store.getTotalTokens('unknown')).toBe(0);
    });
  });

  describe('delete()', () => {
    it('removes a node by id', () => {
      const id = store.add({
        userId: 'u1',
        depth: 0,
        content: 'to be deleted',
        sourceIds: [1, 2],
        tokens: 8,
      });
      expect(store.getById(id)).toBeTruthy();

      store.delete(id);
      expect(store.getById(id)).toBeUndefined();
    });

    it('does not affect other nodes when deleting', () => {
      const id1 = store.add({ userId: 'u1', depth: 0, content: 'keep', sourceIds: [], tokens: 5 });
      const id2 = store.add({ userId: 'u1', depth: 0, content: 'delete me', sourceIds: [], tokens: 5 });

      store.delete(id2);
      expect(store.getById(id1)).toBeTruthy();
      expect(store.getById(id2)).toBeUndefined();
    });
  });

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
});
