import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { MemoryDatabase } from '../database.js';

describe('MemoryDatabase', () => {
  let tmpDir: string;
  let dbPath: string;
  let db: MemoryDatabase;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ccbuddy-db-test-'));
    dbPath = join(tmpDir, 'test.db');
    db = new MemoryDatabase(dbPath);
    db.init();
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates database file at given path', () => {
    expect(existsSync(dbPath)).toBe(true);
  });

  it('creates messages table', () => {
    const row = db.raw().prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='messages'"
    ).get();
    expect(row).toBeTruthy();
  });

  it('creates summary_nodes table', () => {
    const row = db.raw().prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='summary_nodes'"
    ).get();
    expect(row).toBeTruthy();
  });

  it('creates user_profiles table', () => {
    const row = db.raw().prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='user_profiles'"
    ).get();
    expect(row).toBeTruthy();
  });

  it('enables WAL journal mode', () => {
    const row = db.raw().prepare('PRAGMA journal_mode').get() as { journal_mode: string };
    expect(row.journal_mode).toBe('wal');
  });

  it('init() is idempotent — calling twice does not throw', () => {
    expect(() => db.init()).not.toThrow();
  });

  it('async backup() creates a backup file', async () => {
    const backupPath = join(tmpDir, 'backup.db');
    await db.backup(backupPath);
    expect(existsSync(backupPath)).toBe(true);
  });

  it('transaction() wraps operations atomically', () => {
    const raw = db.raw();
    db.transaction(() => {
      raw.prepare(
        'INSERT INTO messages (user_id, session_id, platform, content, role, timestamp, tokens) VALUES (?,?,?,?,?,?,?)'
      ).run('u1', 's1', 'discord', 'hello', 'user', Date.now(), 5);
    });
    const row = raw.prepare('SELECT content FROM messages WHERE user_id=?').get('u1') as { content: string } | undefined;
    expect(row?.content).toBe('hello');
  });
});
