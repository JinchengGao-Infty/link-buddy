import { MemoryDatabase } from './database.js';

export interface SummaryNode {
  id: number;
  userId: string;
  depth: number;
  content: string;
  sourceIds: number[];
  tokens: number;
  timestamp: number;
}

export interface AddSummaryParams {
  userId: string;
  depth: number;
  content: string;
  sourceIds: number[];
  tokens: number;
  timestamp?: number;
}

export class SummaryStore {
  private db: MemoryDatabase;

  constructor(db: MemoryDatabase) {
    this.db = db;
  }

  add(params: AddSummaryParams): number {
    const timestamp = params.timestamp ?? Date.now();

    const result = this.db.raw().prepare(`
      INSERT INTO summary_nodes (user_id, depth, content, source_ids, tokens, timestamp)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      params.userId,
      params.depth,
      params.content,
      JSON.stringify(params.sourceIds),
      params.tokens,
      timestamp,
    );

    return result.lastInsertRowid as number;
  }

  getById(id: number): SummaryNode | undefined {
    const row = this.db.raw().prepare(
      'SELECT * FROM summary_nodes WHERE id = ?'
    ).get(id);
    if (!row) return undefined;
    return this.toNode(row as any);
  }

  getByDepth(userId: string, depth: number): SummaryNode[] {
    const rows = this.db.raw().prepare(`
      SELECT * FROM summary_nodes
      WHERE user_id = ? AND depth = ?
      ORDER BY timestamp ASC, id ASC
    `).all(userId, depth);
    return rows.map((r: any) => this.toNode(r));
  }

  getRecent(userId: string, limit: number): SummaryNode[] {
    const rows = this.db.raw().prepare(`
      SELECT * FROM summary_nodes
      WHERE user_id = ?
      ORDER BY timestamp DESC, id DESC
      LIMIT ?
    `).all(userId, limit);
    return rows.reverse().map((r: any) => this.toNode(r));
  }

  search(userId: string, query: string): SummaryNode[] {
    const rows = this.db.raw().prepare(`
      SELECT * FROM summary_nodes
      WHERE user_id = ? AND content LIKE ?
      ORDER BY timestamp ASC, id ASC
    `).all(userId, `%${query}%`);
    return rows.map((r: any) => this.toNode(r));
  }

  getTotalTokens(userId: string): number {
    const row = this.db.raw().prepare(
      'SELECT COALESCE(SUM(tokens), 0) as total FROM summary_nodes WHERE user_id = ?'
    ).get(userId) as { total: number };
    return row.total;
  }

  delete(id: number): void {
    this.db.raw().prepare(
      'DELETE FROM summary_nodes WHERE id = ?'
    ).run(id);
  }

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

  private toNode(row: any): SummaryNode {
    return {
      id: row.id,
      userId: row.user_id,
      depth: row.depth,
      content: row.content,
      sourceIds: JSON.parse(row.source_ids) as number[],
      tokens: row.tokens,
      timestamp: row.timestamp,
    };
  }
}
