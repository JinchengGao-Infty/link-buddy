import type { AgentBackend, AgentRequest, AgentEvent, AgentEventBase } from '@ccbuddy/core';
import { attachmentsToContentBlocks } from '@ccbuddy/core';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

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
        settingSources: ['user', 'project', 'local'],
      };

      if (request.systemPrompt) {
        options.systemPrompt = request.systemPrompt;
      }

      if (request.mcpServers && request.mcpServers.length > 0) {
        options.mcpServers = Object.fromEntries(
          request.mcpServers.map(s => {
            if (s.type === 'sse') {
              return [s.name, { type: 'sse' as const, url: s.url, headers: s.headers }];
            }
            if (s.type === 'http') {
              return [s.name, { type: 'http' as const, url: s.url, headers: s.headers }];
            }
            // stdio (default)
            return [s.name, { type: 'stdio' as const, command: s.command, args: s.args, env: s.env }];
          })
        );
      }

      if (request.permissionLevel === 'admin' && this.options.skipPermissions) {
        options.permissionMode = 'bypassPermissions';
        options.allowDangerouslySkipPermissions = true;
      } else if (request.permissionLevel === 'system') {
        // System-level requests (scheduler, heartbeat, webhooks) run unattended —
        // bypass permissions since no user is present to approve prompts
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

      // Build prompt: use content blocks when attachments are present, otherwise plain string
      const contentBlocks = request.attachments && request.attachments.length > 0
        ? attachmentsToContentBlocks(request.attachments)
        : [];

      let prompt: string | AsyncIterable<SDKUserMessage>;
      if (contentBlocks.length > 0) {
        const messageContent = [
          ...contentBlocks,
          { type: 'text' as const, text: fullPrompt },
        ];
        const userMessage: SDKUserMessage = {
          type: 'user',
          message: { role: 'user', content: messageContent as any },
          parent_tool_use_id: null,
          session_id: '',
        };
        prompt = (async function* () { yield userMessage; })();
      } else {
        prompt = fullPrompt;
      }

      const result = query({ prompt, options });

      // Track active tools to avoid duplicate yields
      const activeTools = new Set<string>();
      let responseText = '';
      for await (const msg of result) {
        if (msg.type === 'assistant') {
          // Extract tool_use blocks from assistant message content
          const content = (msg as any).message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'tool_use' && !activeTools.has(block.id)) {
                activeTools.add(block.id);
                yield { ...base, type: 'tool_use', tool: block.name, input: block.input };
              }
            }
          }
        } else if (msg.type === 'tool_use_summary') {
          const summary = (msg as any).summary ?? '';
          // Extract tool name from summary (format: "Tool: name\n...")
          const toolIds: string[] = (msg as any).preceding_tool_use_ids ?? [];
          for (const id of toolIds) activeTools.delete(id);
          yield { ...base, type: 'tool_result', tool: '', summary };
        } else if (msg.type === 'result') {
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
