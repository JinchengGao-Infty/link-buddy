import Database from 'better-sqlite3';

export class MemoryDatabase {
  private db: Database.Database;

  constructor(dbPath: string, opts?: { readonly?: boolean }) {
    this.db = new Database(dbPath, opts?.readonly ? { readonly: true } : undefined);
  }

  init(): void {
    // Enable WAL mode for better concurrent read performance
    this.db.pragma('journal_mode = WAL');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        platform TEXT NOT NULL,
        content TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
        attachments TEXT,
        timestamp INTEGER NOT NULL,
        tokens INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id);
      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
      CREATE INDEX IF NOT EXISTS idx_messages_user_ts ON messages(user_id, timestamp);

      CREATE TABLE IF NOT EXISTS summary_nodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        depth INTEGER NOT NULL DEFAULT 0,
        content TEXT NOT NULL,
        source_ids TEXT NOT NULL,
        tokens INTEGER NOT NULL DEFAULT 0,
        timestamp INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_summaries_user ON summary_nodes(user_id);
      CREATE INDEX IF NOT EXISTS idx_summaries_depth ON summary_nodes(user_id, depth);

      CREATE TABLE IF NOT EXISTS user_profiles (
        user_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, key)
      );
    `);

    // Migrations — add consolidation columns if missing
    const messagesCols = this.db.pragma('table_info(messages)') as Array<{ name: string }>;
    if (!messagesCols.some(c => c.name === 'summarized_at')) {
      this.db.exec('ALTER TABLE messages ADD COLUMN summarized_at INTEGER');
    }

    const summaryCols = this.db.pragma('table_info(summary_nodes)') as Array<{ name: string }>;
    if (!summaryCols.some(c => c.name === 'condensed_at')) {
      this.db.exec('ALTER TABLE summary_nodes ADD COLUMN condensed_at INTEGER');
    }
  }

  raw(): Database.Database {
    return this.db;
  }

  async backup(destPath: string): Promise<void> {
    await this.db.backup(destPath);
  }

  close(): void {
    this.db.close();
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }
}
