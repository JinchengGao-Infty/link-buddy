import type { AgentBackend, AgentRequest, AgentEvent, AgentEventBase } from '@ccbuddy/core';
import { query } from '@anthropic-ai/claude-agent-sdk';

export interface SdkBackendOptions {
  skipPermissions?: boolean;
}

// Known limitation: The SDK `query()` function yields SDKMessage events as an
// AsyncGenerator. We collect the final 'result' message to emit a 'complete'
// event. When streaming intermediate text chunks is needed, iterate events
// where msg.type === 'assistant' and yield them as 'text' events.

export class SdkBackend implements AgentBackend {
  private options: SdkBackendOptions;

  constructor(options: SdkBackendOptions = {}) {
    this.options = options;
  }

  async *execute(request: AgentRequest): AsyncGenerator<AgentEvent> {
    const base: AgentEventBase = {
      sessionId: request.sessionId,
      userId: request.userId,
      channelId: request.channelId,
      platform: request.platform,
    };

    try {
      const options: Record<string, any> = {
        allowedTools: request.allowedTools,
        cwd: request.workingDirectory,
      };

      if (request.systemPrompt) {
        options.systemPrompt = request.systemPrompt;
      }

      if (request.permissionLevel === 'admin' && this.options.skipPermissions) {
        options.permissionMode = 'bypassPermissions';
        options.allowDangerouslySkipPermissions = true;
      } else if (request.permissionLevel === 'chat') {
        options.allowedTools = [];
        // Restrict to text-only responses for chat users
        const chatRestriction = 'IMPORTANT: You are in chat-only mode. Do NOT use any tools (no Bash, no file operations, no web searches). Only respond with text.';
        options.systemPrompt = options.systemPrompt
          ? `${options.systemPrompt}\n\n${chatRestriction}`
          : chatRestriction;
      }

      let fullPrompt = request.prompt;
      if (request.memoryContext) {
        fullPrompt = `<memory_context>\n${request.memoryContext}\n</memory_context>\n\n${request.prompt}`;
      }

      const result = query({ prompt: fullPrompt, options });

      let responseText = '';
      for await (const msg of result) {
        if (msg.type === 'result') {
          if ((msg as any).subtype === 'success') {
            responseText = (msg as any).result ?? '';
          } else {
            const errors: string[] = (msg as any).errors ?? [];
            throw new Error(errors.join('; ') || `Query ended with subtype: ${(msg as any).subtype}`);
          }
        }
      }

      yield { ...base, type: 'complete', response: responseText };
    } catch (err) {
      yield { ...base, type: 'error', error: (err as Error).message };
    }
  }

  async abort(_sessionId: string): Promise<void> {
    // SDK doesn't have a direct abort — future: track AbortControllers per session
  }
}
