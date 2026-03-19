import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { MemoryDatabase } from '../database.js';
import { MessageStore } from '../message-store.js';

describe('MessageStore', () => {
  let tmpDir: string;
  let db: MemoryDatabase;
  let store: MessageStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ccbuddy-ms-test-'));
    db = new MemoryDatabase(join(tmpDir, 'test.db'));
    db.init();
    store = new MessageStore(db);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('add() and getById()', () => {
    it('stores a message and retrieves it by id', () => {
      const id = store.add({
        userId: 'u1',
        sessionId: 's1',
        platform: 'discord',
        content: 'Hello world',
        role: 'user',
      });
      expect(id).toBeGreaterThan(0);

      const msg = store.getById(id);
      expect(msg).toBeTruthy();
      expect(msg!.userId).toBe('u1');
      expect(msg!.sessionId).toBe('s1');
      expect(msg!.platform).toBe('discord');
      expect(msg!.content).toBe('Hello world');
      expect(msg!.role).toBe('user');
    });

    it('auto-calculates tokens when not provided', () => {
      const id = store.add({
        userId: 'u1',
        sessionId: 's1',
        platform: 'discord',
        content: 'abcd', // 4 chars -> 1 token
        role: 'user',
      });
      const msg = store.getById(id);
      expect(msg!.tokens).toBe(1);
    });

    it('uses provided tokens when given', () => {
      const id = store.add({
        userId: 'u1',
        sessionId: 's1',
        platform: 'discord',
        content: 'hello',
        role: 'user',
        tokens: 42,
      });
      const msg = store.getById(id);
      expect(msg!.tokens).toBe(42);
    });

    it('auto-sets timestamp when not provided', () => {
      const before = Date.now();
      const id = store.add({
        userId: 'u1',
        sessionId: 's1',
        platform: 'discord',
        content: 'hi',
        role: 'user',
      });
      const after = Date.now();
      const msg = store.getById(id);
      expect(msg!.timestamp).toBeGreaterThanOrEqual(before);
      expect(msg!.timestamp).toBeLessThanOrEqual(after);
    });

    it('returns undefined for non-existent id', () => {
      expect(store.getById(9999)).toBeUndefined();
    });

    it('stores and retrieves attachments', () => {
      const attachments = JSON.stringify([{ type: 'image', url: 'http://example.com/img.png' }]);
      const id = store.add({
        userId: 'u1',
        sessionId: 's1',
        platform: 'discord',
        content: 'see attached',
        role: 'user',
        attachments,
      });
      const msg = store.getById(id);
      expect(msg!.attachments).toBe(attachments);
    });
  });

  describe('getFreshTail()', () => {
    it('returns last N messages in chronological order', () => {
      const base = Date.now();
      store.add({ userId: 'u1', sessionId: 's1', platform: 'discord', content: 'msg1', role: 'user', timestamp: base });
      store.add({ userId: 'u1', sessionId: 's1', platform: 'discord', content: 'msg2', role: 'assistant', timestamp: base + 1 });
      store.add({ userId: 'u1', sessionId: 's1', platform: 'discord', content: 'msg3', role: 'user', timestamp: base + 2 });

      const tail = store.getFreshTail('u1', 's1', 2);
      expect(tail).toHaveLength(2);
      expect(tail[0].content).toBe('msg2');
      expect(tail[1].content).toBe('msg3');
    });

    it('returns all messages when limit exceeds count', () => {
      store.add({ userId: 'u1', sessionId: 's1', platform: 'discord', content: 'only', role: 'user' });
      const tail = store.getFreshTail('u1', 's1', 10);
      expect(tail).toHaveLength(1);
    });

    it('only returns messages for the specified session', () => {
      store.add({ userId: 'u1', sessionId: 's1', platform: 'discord', content: 'session1', role: 'user' });
      store.add({ userId: 'u1', sessionId: 's2', platform: 'discord', content: 'session2', role: 'user' });

      const tail = store.getFreshTail('u1', 's1', 10);
      expect(tail).toHaveLength(1);
      expect(tail[0].content).toBe('session1');
    });
  });

  describe('getByUser()', () => {
    it('retrieves all messages for a user across sessions', () => {
      store.add({ userId: 'u1', sessionId: 's1', platform: 'discord', content: 'a', role: 'user' });
      store.add({ userId: 'u1', sessionId: 's2', platform: 'telegram', content: 'b', role: 'assistant' });
      store.add({ userId: 'u2', sessionId: 's3', platform: 'discord', content: 'c', role: 'user' });

      const msgs = store.getByUser('u1');
      expect(msgs).toHaveLength(2);
      expect(msgs.every(m => m.userId === 'u1')).toBe(true);
    });

    it('respects optional limit', () => {
      for (let i = 0; i < 5; i++) {
        store.add({ userId: 'u1', sessionId: 's1', platform: 'discord', content: `msg${i}`, role: 'user' });
      }
      const msgs = store.getByUser('u1', 3);
      expect(msgs).toHaveLength(3);
    });
  });

  describe('user isolation', () => {
    it('getFreshTail does not return other users messages', () => {
      store.add({ userId: 'u1', sessionId: 's1', platform: 'discord', content: 'user1 msg', role: 'user' });
      store.add({ userId: 'u2', sessionId: 's1', platform: 'discord', content: 'user2 msg', role: 'user' });

      const tail = store.getFreshTail('u1', 's1', 10);
      expect(tail).toHaveLength(1);
      expect(tail[0].userId).toBe('u1');
    });
  });

  describe('getTotalTokens()', () => {
    it('sums tokens for all messages by user', () => {
      store.add({ userId: 'u1', sessionId: 's1', platform: 'discord', content: 'hi', role: 'user', tokens: 10 });
      store.add({ userId: 'u1', sessionId: 's1', platform: 'discord', content: 'bye', role: 'assistant', tokens: 20 });
      store.add({ userId: 'u2', sessionId: 's1', platform: 'discord', content: 'other', role: 'user', tokens: 100 });

      expect(store.getTotalTokens('u1')).toBe(30);
    });

    it('returns 0 when user has no messages', () => {
      expect(store.getTotalTokens('unknown')).toBe(0);
    });
  });

  describe('getByTimeRange()', () => {
    it('returns messages within the time range', () => {
      const base = 1000000;
      store.add({ userId: 'u1', sessionId: 's1', platform: 'discord', content: 'before', role: 'user', timestamp: base - 100 });
      store.add({ userId: 'u1', sessionId: 's1', platform: 'discord', content: 'in', role: 'user', timestamp: base });
      store.add({ userId: 'u1', sessionId: 's1', platform: 'discord', content: 'also in', role: 'user', timestamp: base + 100 });
      store.add({ userId: 'u1', sessionId: 's1', platform: 'discord', content: 'after', role: 'user', timestamp: base + 200 });

      const msgs = store.getByTimeRange('u1', base, base + 100);
      expect(msgs).toHaveLength(2);
      expect(msgs.map(m => m.content)).toEqual(['in', 'also in']);
    });
  });

  describe('search()', () => {
    it('finds messages matching content query', () => {
      store.add({ userId: 'u1', sessionId: 's1', platform: 'discord', content: 'hello world', role: 'user' });
      store.add({ userId: 'u1', sessionId: 's1', platform: 'discord', content: 'goodbye moon', role: 'user' });
      store.add({ userId: 'u1', sessionId: 's1', platform: 'discord', content: 'hello again', role: 'user' });

      const results = store.search('u1', 'hello');
      expect(results).toHaveLength(2);
      expect(results.every(m => m.content.includes('hello'))).toBe(true);
    });

    it('does not return results from other users', () => {
      store.add({ userId: 'u1', sessionId: 's1', platform: 'discord', content: 'hello u1', role: 'user' });
      store.add({ userId: 'u2', sessionId: 's2', platform: 'discord', content: 'hello u2', role: 'user' });

      const results = store.search('u1', 'hello');
      expect(results).toHaveLength(1);
      expect(results[0].userId).toBe('u1');
    });
  });

  describe('getMessageCount()', () => {
    it('returns correct count for user', () => {
      expect(store.getMessageCount('u1')).toBe(0);
      store.add({ userId: 'u1', sessionId: 's1', platform: 'discord', content: 'a', role: 'user' });
      store.add({ userId: 'u1', sessionId: 's1', platform: 'discord', content: 'b', role: 'user' });
      store.add({ userId: 'u2', sessionId: 's2', platform: 'discord', content: 'c', role: 'user' });
      expect(store.getMessageCount('u1')).toBe(2);
    });
  });

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
      const msgs = store.getUnsummarizedMessages('u1', 0);
      expect(msgs).toHaveLength(0);
    });
  });

  describe('pruneOldSummarized()', () => {
    it('deletes summarized messages older than threshold', () => {
      const id1 = store.add({ userId: 'u1', sessionId: 's1', platform: 'discord', content: 'old', role: 'user' });
      const id2 = store.add({ userId: 'u1', sessionId: 's1', platform: 'discord', content: 'new', role: 'user' });
      store.markSummarized([id1], 1000);
      store.markSummarized([id2], Date.now());
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
});
