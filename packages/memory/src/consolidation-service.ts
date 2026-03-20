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
    if (pruned > 0 && results.size > 0) {
      const firstStats = results.values().next().value!;
      firstStats.messagesPruned = pruned;
    }

    return results;
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
    const maxDepth = 10;

    while (depth < maxDepth) {
      const uncondensed = this.summaryStore.getUncondensedByDepth(userId, depth);
      if (uncondensed.length < 4) break;

      // Batch uncondensed nodes by token budget to prevent oversized summarization calls
      const chunks: typeof uncondensed[] = [];
      let currentChunk: typeof uncondensed = [];
      let currentTokens = 0;

      for (const node of uncondensed) {
        if (currentTokens + node.tokens > this.config.condensed_target_tokens && currentChunk.length > 0) {
          chunks.push(currentChunk);
          currentChunk = [];
          currentTokens = 0;
        }
        currentChunk.push(node);
        currentTokens += node.tokens;
      }
      if (currentChunk.length > 0) {
        chunks.push(currentChunk);
      }

      for (const chunk of chunks) {
        const text = chunk.map(n => n.content).join('\n\n---\n\n');
        const summary = await this.summarize(text);
        const sourceIds = chunk.map(n => n.id);
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
      }

      depth++;
    }
  }

  private pruneOldMessages(): number {
    const retentionMs = this.config.message_retention_days * 86400000;
    const cutoff = Date.now() - retentionMs;
    return this.messageStore.pruneOldSummarized(cutoff);
  }
}
