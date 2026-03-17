import { describe, it, expect, vi } from 'vitest';
import { SdkBackend } from '../backends/sdk-backend.js';
import type { AgentRequest } from '@ccbuddy/core';

// Mock @anthropic-ai/claude-agent-sdk
vi.mock('@anthropic-ai/claude-agent-sdk', () => {
  return {
    query: vi.fn(),
  };
});

import { query } from '@anthropic-ai/claude-agent-sdk';
const mockQuery = query as ReturnType<typeof vi.fn>;

function makeRequest(overrides: Partial<AgentRequest> = {}): AgentRequest {
  return {
    prompt: 'Hello',
    userId: 'user1',
    sessionId: 'sess-1',
    channelId: 'general',
    platform: 'discord',
    permissionLevel: 'admin',
    ...overrides,
  };
}

async function* successGenerator() {
  yield { type: 'result', subtype: 'success', result: 'Hello back!' };
}

describe('SdkBackend', () => {
  it('passes through admin requests without chat restriction', async () => {
    mockQuery.mockReturnValue(successGenerator());

    const backend = new SdkBackend({ skipPermissions: false });
    const events = [];
    for await (const event of backend.execute(makeRequest({ permissionLevel: 'admin' }))) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('complete');

    const callOptions = mockQuery.mock.calls[0][0].options;
    // No chat restriction for admin
    expect(callOptions.systemPrompt ?? '').not.toContain('chat-only mode');
  });

  it('adds system prompt restriction for chat users', async () => {
    mockQuery.mockReturnValue(successGenerator());

    const backend = new SdkBackend();
    const events = [];
    for await (const event of backend.execute(makeRequest({ permissionLevel: 'chat' }))) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('complete');

    const callOptions = mockQuery.mock.calls[0][0].options;
    expect(callOptions.allowedTools).toEqual([]);
    expect(callOptions.systemPrompt).toContain('chat-only mode');
    expect(callOptions.systemPrompt).toContain('Do NOT use any tools');
  });

  it('prepends existing system prompt with chat restriction for chat users', async () => {
    mockQuery.mockReturnValue(successGenerator());

    const backend = new SdkBackend();
    const events = [];
    for await (const event of backend.execute(
      makeRequest({ permissionLevel: 'chat', systemPrompt: 'You are a helpful assistant.' })
    )) {
      events.push(event);
    }

    const callOptions = mockQuery.mock.calls[0][0].options;
    expect(callOptions.systemPrompt).toContain('You are a helpful assistant.');
    expect(callOptions.systemPrompt).toContain('chat-only mode');
    // Original prompt should come first
    const idx1 = callOptions.systemPrompt.indexOf('You are a helpful assistant.');
    const idx2 = callOptions.systemPrompt.indexOf('chat-only mode');
    expect(idx1).toBeLessThan(idx2);
  });

  it('sets bypassPermissions for admin with skipPermissions=true', async () => {
    mockQuery.mockReturnValue(successGenerator());

    const backend = new SdkBackend({ skipPermissions: true });
    for await (const _event of backend.execute(makeRequest({ permissionLevel: 'admin' }))) {}

    const callOptions = mockQuery.mock.calls[0][0].options;
    expect(callOptions.permissionMode).toBe('bypassPermissions');
    expect(callOptions.allowDangerouslySkipPermissions).toBe(true);
  });
});
