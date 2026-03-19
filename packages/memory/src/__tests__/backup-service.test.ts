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
