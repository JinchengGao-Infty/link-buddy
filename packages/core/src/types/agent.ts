export interface Attachment {
  type: 'image' | 'file' | 'voice';
  mimeType: string;
  data: Buffer;
  filename?: string;
  transcript?: string;
}

export type McpServerSpec =
  | { name: string; type?: 'stdio'; command: string; args: string[]; env?: Record<string, string> }
  | { name: string; type: 'sse'; url: string; headers?: Record<string, string> }
  | { name: string; type: 'http'; url: string; headers?: Record<string, string> };

export interface AgentRequest {
  prompt: string;
  userId: string;
  sessionId: string;
  channelId: string;
  platform: string;
  workingDirectory?: string;
  allowedTools?: string[];
  systemPrompt?: string;
  memoryContext?: string;
  attachments?: Attachment[];
  permissionLevel: 'admin' | 'chat' | 'system';
  mcpServers?: Array<McpServerSpec>;
}

export interface AgentEventBase {
  sessionId: string;
  userId: string;
  channelId: string;
  platform: string;
}

export type AgentEvent =
  | AgentEventBase & { type: 'text'; content: string }
  | AgentEventBase & { type: 'tool_use'; tool: string; input?: Record<string, unknown> }
  | AgentEventBase & { type: 'tool_result'; tool: string; summary: string }
  | AgentEventBase & { type: 'complete'; response: string }
  | AgentEventBase & { type: 'error'; error: string }
  | AgentEventBase & { type: 'media'; media: Array<{ data: Buffer; mimeType: string; filename?: string }> };

export interface AgentBackend {
  execute(request: AgentRequest): AsyncGenerator<AgentEvent>;
  abort(sessionId: string): Promise<void>;
}

export interface ToolDescription {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description?: string; enum?: string[]; default?: unknown }>;
    required?: string[];
  };
}
