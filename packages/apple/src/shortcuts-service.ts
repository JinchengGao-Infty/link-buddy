import { execFile } from 'node:child_process';
import type { ToolDescription } from '@ccbuddy/core';

export interface ShortcutInfo {
  name: string;
}

export interface ShortcutRunResult {
  output: string;
}

export class AppleShortcutsService {
  private readonly timeoutMs: number;

  constructor(timeoutMs = 30000) {
    this.timeoutMs = timeoutMs;
  }

  async listShortcuts(): Promise<ShortcutInfo[]> {
    const stdout = await this.execCommand(['list']);
    return stdout.trim().split('\n').filter(Boolean).map(name => ({ name: name.trim() }));
  }

  async runShortcut(name: string, input?: string): Promise<ShortcutRunResult> {
    const args = ['run', name];
    if (input) {
      args.push('-i', input);
    }
    const output = await this.execCommand(args);
    return { output: output.trim() };
  }

  getToolDefinitions(): ToolDescription[] {
    return [
      {
        name: 'apple_shortcuts_list',
        description: 'List all available Apple Shortcuts.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'apple_shortcuts_run',
        description: 'Run an Apple Shortcut by name. Shortcuts can control HomeKit devices, set Focus modes, automate apps, and more.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Name of the shortcut to run' },
            input: { type: 'string', description: 'Optional text input to pass to the shortcut' },
          },
          required: ['name'],
        },
      },
    ];
  }

  private execCommand(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile('shortcuts', args, { timeout: this.timeoutMs }, (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`Shortcuts command failed: ${stderr || err.message}`));
          return;
        }
        resolve(stdout);
      });
    });
  }
}
