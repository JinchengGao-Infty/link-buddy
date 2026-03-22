import { MessageStore, type StoredMessage } from './message-store.js';
import { SummaryStore, type SummaryNode } from './summary-store.js';
import { ProfileStore } from './profile-store.js';

export interface ContextAssemblerConfig {
  maxContextTokens: number;
  freshTailCount: number; // kept for backward compat, but no longer the primary limit
  contextThreshold: number; // 0.0 - 1.0: trigger compaction when stored tokens exceed this ratio
}

export interface AssembledContext {
  profile: string;
  messages: StoredMessage[];
  summaries: SummaryNode[];
  totalTokens: number;
  needsCompaction: boolean;
}

export class ContextAssembler {
  private messages: MessageStore;
  private summaries: SummaryStore;
  private profiles: ProfileStore;
  private config: ContextAssemblerConfig;

  constructor(
    messages: MessageStore,
    summaries: SummaryStore,
    profiles: ProfileStore,
    config: ContextAssemblerConfig,
  ) {
    this.messages = messages;
    this.summaries = summaries;
    this.profiles = profiles;
    this.config = config;
  }

  assemble(userId: string, sessionId: string): AssembledContext {
    const { maxContextTokens, contextThreshold } = this.config;

    // 1. Get user profile text
    const profile = this.profiles.getAsContext(userId);
    const profileTokens = profile.length > 0 ? Math.ceil(profile.length / 4) : 0;

    let remainingBudget = maxContextTokens - profileTokens;

    // 2. Get summaries first (compressed history, high priority)
    const allSummaries = this.getAllSummariesByPriority(userId);
    const selectedSummaries: SummaryNode[] = [];
    let summaryTokens = 0;

    // Reserve at least 50% of budget for raw messages
    const summaryBudget = Math.floor(remainingBudget * 0.5);
    for (const node of allSummaries) {
      if (summaryTokens >= summaryBudget) break;
      if (summaryTokens + node.tokens <= summaryBudget) {
        selectedSummaries.push(node);
        summaryTokens += node.tokens;
      }
    }

    remainingBudget -= summaryTokens;

    // 3. Fill remaining budget with raw messages (newest first, as many as fit)
    const allMessages = this.messages.getFreshTail(userId, sessionId, 100000);
    const selectedMessages: StoredMessage[] = [];
    let messageTokens = 0;

    // Walk from newest to oldest, collecting messages until budget is exhausted
    for (let i = allMessages.length - 1; i >= 0; i--) {
      const msg = allMessages[i];
      if (messageTokens + msg.tokens > remainingBudget) break;
      selectedMessages.unshift(msg); // prepend to maintain chronological order
      messageTokens += msg.tokens;
    }

    // 4. Calculate totals
    const totalTokens = profileTokens + summaryTokens + messageTokens;

    // 5. Compaction needed when stored tokens exceed threshold
    const storedMessageTokens = this.messages.getTotalTokens(userId);
    const storedSummaryTokens = this.summaries.getTotalTokens(userId);
    const totalStoredTokens = storedMessageTokens + storedSummaryTokens;
    const needsCompaction = totalStoredTokens > maxContextTokens * contextThreshold;

    return {
      profile,
      messages: selectedMessages,
      summaries: selectedSummaries,
      totalTokens,
      needsCompaction,
    };
  }

  formatAsPrompt(context: AssembledContext): string {
    const parts: string[] = [];

    if (context.profile.length > 0) {
      parts.push(`<user_profile>\n${context.profile}\n</user_profile>`);
    } else {
      parts.push(`<user_profile>\n</user_profile>`);
    }

    if (context.summaries.length > 0) {
      const summaryText = context.summaries
        .map(s => s.content)
        .join('\n\n');
      parts.push(`<conversation_history_summary>\n${summaryText}\n</conversation_history_summary>`);
    } else {
      parts.push(`<conversation_history_summary>\n</conversation_history_summary>`);
    }

    if (context.messages.length > 0) {
      const messageText = context.messages
        .map(m => `[${m.role}]: ${m.content}`)
        .join('\n');
      parts.push(`<recent_messages>\n${messageText}\n</recent_messages>`);
    } else {
      parts.push(`<recent_messages>\n</recent_messages>`);
    }

    return parts.join('\n\n');
  }

  private getAllSummariesByPriority(userId: string): SummaryNode[] {
    const raw = this.summaries.getRecent(userId, 10000);
    // Sort by depth DESC (higher = more condensed = higher priority),
    // then by timestamp DESC (newer first within same depth)
    raw.sort((a, b) => {
      if (b.depth !== a.depth) return b.depth - a.depth;
      return b.timestamp - a.timestamp;
    });
    return raw;
  }
}
