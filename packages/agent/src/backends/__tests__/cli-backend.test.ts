import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentRequest } from '@ccbuddy/core';
import { EventEmitter } from 'events';

// Mock child_process.spawn before importing the module under test
vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

import { spawn } from 'child_process';
const mockSpawn = vi.mocked(spawn);

import { CliBackend } from '../cli-backend.js';

// Helper: create a fake child process with controllable stdout/stderr/close
function makeMockProcess() {
  const stdout = new EventEmitter() as NodeJS.EventEmitter & { pipe?: any };
  const stderr = new EventEmitter() as NodeJS.EventEmitter & { pipe?: any };
  const proc = new EventEmitter() as any;
  proc.stdout = stdout;
  proc.stderr = stderr;
  proc.kill = vi.fn();
  return proc;
}

function makeRequest(overrides: Partial<AgentRequest> = {}): AgentRequest {
  return {
    prompt: 'Hello',
    userId: 'dad',
    sessionId: 'dad-discord-dev',
    channelId: 'dev',
    platform: 'discord',
    permissionLevel: 'admin',
    ...overrides,
  };
}

describe('CliBackend', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('spawns claude CLI with correct flags', async () => {
    const proc = makeMockProcess();
    mockSpawn.mockReturnValue(proc);

    const backend = new CliBackend();
    const request = makeRequest();

    const executePromise = (async () => {
      const events: any[] = [];
      const gen = backend.execute(request);
      // Start consuming the generator (will be pending until proc closes)
      const nextPromise = gen.next();

      // Simulate successful NDJSON output
      process.nextTick(() => {
        proc.stdout.emit('data', Buffer.from('{"type":"result","result":"Hi there"}\n'));
        proc.emit('close', 0);
      });

      const result = await nextPromise;
      if (!result.done) events.push(result.value);
      return events;
    })();

    const events = await executePromise;

    expect(mockSpawn).toHaveBeenCalledOnce();
    const [cmd, args] = mockSpawn.mock.calls[0];
    expect(cmd).toBe('claude');
    expect(args).toContain('-p');
    expect(args).toContain('Hello');
    expect(args).toContain('--output-format');
    expect(args).toContain('stream-json');
    expect(args).toContain('--session-id');
    expect(args).toContain('dad-discord-dev');
  });

  it('emits complete event with response from NDJSON result line', async () => {
    const proc = makeMockProcess();
    mockSpawn.mockReturnValue(proc);

    const backend = new CliBackend();
    const request = makeRequest();

    const events: any[] = [];
    const gen = backend.execute(request);
    const nextPromise = gen.next();

    process.nextTick(() => {
      proc.stdout.emit('data', Buffer.from('{"type":"result","result":"Hi there"}\n'));
      proc.emit('close', 0);
    });

    const result = await nextPromise;
    if (!result.done) events.push(result.value);

    const complete = events.find((e) => e.type === 'complete');
    expect(complete).toBeDefined();
    expect(complete.response).toBe('Hi there');
  });

  it('includes routing metadata (sessionId, userId, channelId, platform) in all events', async () => {
    const proc = makeMockProcess();
    mockSpawn.mockReturnValue(proc);

    const backend = new CliBackend();
    const request = makeRequest({
      userId: 'dad',
      sessionId: 's42',
      channelId: 'general',
      platform: 'telegram',
    });

    const events: any[] = [];
    const gen = backend.execute(request);
    const nextPromise = gen.next();

    process.nextTick(() => {
      proc.stdout.emit('data', Buffer.from('{"type":"result","result":"reply"}\n'));
      proc.emit('close', 0);
    });

    const result = await nextPromise;
    if (!result.done) events.push(result.value);

    for (const event of events) {
      expect(event.sessionId).toBe('s42');
      expect(event.userId).toBe('dad');
      expect(event.channelId).toBe('general');
      expect(event.platform).toBe('telegram');
    }
  });

  it('emits error event on non-zero exit code', async () => {
    const proc = makeMockProcess();
    mockSpawn.mockReturnValue(proc);

    const backend = new CliBackend();
    const request = makeRequest();

    const events: any[] = [];
    const gen = backend.execute(request);
    const nextPromise = gen.next();

    process.nextTick(() => {
      proc.stderr.emit('data', Buffer.from('something went wrong'));
      proc.emit('close', 1);
    });

    const result = await nextPromise;
    if (!result.done) events.push(result.value);

    const error = events.find((e) => e.type === 'error');
    expect(error).toBeDefined();
    expect(error.error).toContain('1');
  });

  it('includes routing metadata in error events', async () => {
    const proc = makeMockProcess();
    mockSpawn.mockReturnValue(proc);

    const backend = new CliBackend();
    const request = makeRequest({
      userId: 'dad',
      sessionId: 'err-session',
      channelId: 'ch1',
      platform: 'discord',
    });

    const events: any[] = [];
    const gen = backend.execute(request);
    const nextPromise = gen.next();

    process.nextTick(() => {
      proc.emit('close', 127);
    });

    const result = await nextPromise;
    if (!result.done) events.push(result.value);

    const error = events.find((e) => e.type === 'error');
    expect(error).toBeDefined();
    expect(error.sessionId).toBe('err-session');
    expect(error.userId).toBe('dad');
    expect(error.channelId).toBe('ch1');
    expect(error.platform).toBe('discord');
  });

  it('aborts the running process on abort()', async () => {
    const proc = makeMockProcess();
    mockSpawn.mockReturnValue(proc);

    const backend = new CliBackend();
    const request = makeRequest({ sessionId: 'abort-session' });

    // Start execute but don't await — keep it pending
    const gen = backend.execute(request);
    const nextPromise = gen.next();

    // Give the process a tick to get registered
    await new Promise((r) => process.nextTick(r));

    await backend.abort('abort-session');
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');

    // Clean up: let the process close so the generator resolves
    proc.emit('close', 0);
    await nextPromise;
  });
});
