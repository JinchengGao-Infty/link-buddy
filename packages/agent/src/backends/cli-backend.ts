import { spawn, type ChildProcess } from 'child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentBackend, AgentRequest, AgentEvent, AgentEventBase } from '@ccbuddy/core';

export class CliBackend implements AgentBackend {
  private processes: Map<string, ChildProcess> = new Map();

  async *execute(request: AgentRequest): AsyncGenerator<AgentEvent> {
    const base: AgentEventBase = {
      sessionId: request.sessionId,
      userId: request.userId,
      channelId: request.channelId,
      platform: request.platform,
    };

    let attachmentNote = '';
    if (request.attachments && request.attachments.length > 0) {
      console.warn('[CliBackend] Attachments not supported in CLI mode — including metadata only');
      attachmentNote = request.attachments.map(a => {
        const sizeKB = Math.round(a.data.byteLength / 1024);
        return `[Attached: ${a.mimeType} "${a.filename ?? 'unnamed'}" (${sizeKB}KB)]`;
      }).join('\n') + '\n\n';
    }

    const args: string[] = [
      '-p', attachmentNote + request.prompt,
      '--output-format', 'stream-json',
      '--verbose',
    ];

    if (request.workingDirectory) args.push('--cwd', request.workingDirectory);

    let mcpConfigPath: string | undefined;
    if (request.mcpServers && request.mcpServers.length > 0) {
      mcpConfigPath = this.writeTempMcpConfig(request.mcpServers);
      args.push('--mcp-config', mcpConfigPath);
    }

    // Pass system prompt for admin/system users (needed for skill nudge)
    if (request.systemPrompt && request.permissionLevel !== 'chat') {
      args.push('--system-prompt', request.systemPrompt);
    }

    // System-level requests (scheduler) run unattended — no tool restrictions needed
    if (request.permissionLevel === 'chat') {
      args.push('--allowedTools', '');
      // Restrict to text-only responses for chat users via system prompt
      const chatRestriction = 'IMPORTANT: You are in chat-only mode. Do NOT use any tools (no Bash, no file operations, no web searches). Only respond with text.';
      const effectiveSystemPrompt = request.systemPrompt
        ? `${request.systemPrompt}\n\n${chatRestriction}`
        : chatRestriction;
      args.push('--system-prompt', effectiveSystemPrompt);
    }

    try {
      const result = await this.runClaude(args, request.sessionId);
      yield { ...base, type: 'complete', response: result };
    } catch (err) {
      yield { ...base, type: 'error', error: (err as Error).message };
    } finally {
      if (mcpConfigPath) {
        try { unlinkSync(mcpConfigPath); } catch { /* ignore cleanup errors */ }
      }
    }
  }

  async abort(sessionId: string): Promise<void> {
    const proc = this.processes.get(sessionId);
    if (proc) {
      proc.kill('SIGTERM');
      this.processes.delete(sessionId);
    }
  }

  private writeTempMcpConfig(mcpServers: AgentRequest['mcpServers']): string {
    const config = {
      mcpServers: Object.fromEntries(
        (mcpServers ?? []).map(s => [s.name, { type: 'stdio', command: s.command, args: s.args, env: s.env }])
      ),
    };
    const configPath = join(tmpdir(), `ccbuddy-mcp-${Date.now()}.json`);
    writeFileSync(configPath, JSON.stringify(config));
    return configPath;
  }

  private runClaude(args: string[], sessionId: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn('claude', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      this.processes.set(sessionId, proc);

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
      proc.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

      proc.on('close', (code: number | null) => {
        this.processes.delete(sessionId);
        if (code !== 0) {
          reject(new Error(`claude CLI exited with code ${code}: ${stderr}`));
          return;
        }
        try {
          // stream-json produces NDJSON (one JSON object per line)
          const lines = stdout.trim().split('\n').filter(Boolean);
          let responseText = '';
          for (const line of lines) {
            try {
              const obj = JSON.parse(line);
              if (obj.type === 'result' && obj.result) {
                responseText = obj.result;
              } else if (obj.type === 'text' && obj.text) {
                responseText += obj.text;
              } else if (obj.type === 'assistant' && obj.message?.content) {
                const texts = obj.message.content
                  .filter((b: any) => b.type === 'text')
                  .map((b: any) => b.text);
                responseText += texts.join('\n');
              }
            } catch { /* skip unparseable lines */ }
          }
          resolve(responseText || stdout);
        } catch {
          resolve(stdout);
        }
      });
    });
  }
}
