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
      return;
    }

    while (files.length > this.maxBackups) {
      const oldest = files.shift()!;
      unlinkSync(join(this.backupDir, oldest));
    }
  }
}
