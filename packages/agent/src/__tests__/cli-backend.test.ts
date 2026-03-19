import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CliBackend } from '../backends/cli-backend.js';
import type { AgentRequest } from '@ccbuddy/core';

// Mock child_process so no real `claude` binary is invoked
vi.mock('child_process', () => {
  const EventEmitter = require('events');

  function makeMockProc(stdout: string, exitCode = 0) {
    const proc: any = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = vi.fn();

    // Emit output and close asynchronously
    setTimeout(() => {
      proc.stdout.emit('data', Buffer.from(stdout));
      proc.emit('close', exitCode);
    }, 0);

    return proc;
  }

  return {
    spawn: vi.fn(() =>
      makeMockProc(
        JSON.stringify({ type: 'result', result: 'OK' }) + '\n'
      )
    ),
  };
});

// Mock fs/os so temp-file writes don't hit the real filesystem
vi.mock('node:fs', () => ({ writeFileSync: vi.fn(), unlinkSync: vi.fn() }));

import { spawn } from 'child_process';
const mockSpawn = spawn as ReturnType<typeof vi.fn>;

function makeRequest(overrides: Partial<AgentRequest> = {}): AgentRequest {
  return {
    prompt: 'What is in this image?',
    userId: 'user1',
    sessionId: 'sess-1',
    channelId: 'general',
    platform: 'discord',
    permissionLevel: 'admin',
    ...overrides,
  };
}

describe('CliBackend', () => {
  beforeEach(() => {
    mockSpawn.mockClear();
  });

  it('passes the plain prompt when no attachments are present', async () => {
    const backend = new CliBackend();
    const events = [];
    for await (const event of backend.execute(makeRequest())) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('complete');

    const spawnArgs: string[] = mockSpawn.mock.calls[0][1];
    const promptIndex = spawnArgs.indexOf('-p');
    expect(promptIndex).toBeGreaterThanOrEqual(0);
    const promptValue = spawnArgs[promptIndex + 1];
    expect(promptValue).toBe('What is in this image?');
  });

  it('prepends attachment metadata to prompt text and warns when attachments present', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const imageData = Buffer.alloc(2048); // 2 KB
    const backend = new CliBackend();
    const events = [];
    for await (const event of backend.execute(
      makeRequest({
        attachments: [
          { type: 'image', mimeType: 'image/png', data: imageData, filename: 'screenshot.png' },
        ],
      })
    )) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('complete');

    const spawnArgs: string[] = mockSpawn.mock.calls[0][1];
    const promptIndex = spawnArgs.indexOf('-p');
    const promptValue = spawnArgs[promptIndex + 1];

    expect(promptValue).toContain('[Attached: image/png "screenshot.png" (2KB)]');
    expect(promptValue).toContain('What is in this image?');
    // Metadata should precede the original prompt
    expect(promptValue.indexOf('[Attached:')).toBeLessThan(promptValue.indexOf('What is in this image?'));

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[CliBackend] Attachments not supported in CLI mode')
    );

    warnSpy.mockRestore();
  });

  it('includes metadata for multiple attachments', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const backend = new CliBackend();
    const events = [];
    for await (const event of backend.execute(
      makeRequest({
        attachments: [
          { type: 'image', mimeType: 'image/jpeg', data: Buffer.alloc(1024), filename: 'photo.jpg' },
          { type: 'file', mimeType: 'application/pdf', data: Buffer.alloc(4096) },
        ],
      })
    )) {
      events.push(event);
    }

    const spawnArgs: string[] = mockSpawn.mock.calls[0][1];
    const promptIndex = spawnArgs.indexOf('-p');
    const promptValue = spawnArgs[promptIndex + 1];

    expect(promptValue).toContain('[Attached: image/jpeg "photo.jpg" (1KB)]');
    expect(promptValue).toContain('[Attached: application/pdf "unnamed" (4KB)]');

    warnSpy.mockRestore();
  });
});
