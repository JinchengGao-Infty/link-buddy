import { describe, it, expect } from 'vitest';
import { shouldRespond } from '../activation.js';
import type { IncomingMessage, PlatformConfig } from '@ccbuddy/core';

function makeMsg(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    platform: 'discord',
    platformUserId: '123',
    channelId: 'ch1',
    channelType: 'group',
    text: 'hello',
    attachments: [],
    isMention: false,
    raw: null,
    ...overrides,
  };
}

describe('shouldRespond', () => {
  it('always responds to DMs', () => {
    expect(shouldRespond(makeMsg({ channelType: 'dm' }), {})).toBe(true);
  });

  it('responds to mentions when no channel config exists', () => {
    expect(shouldRespond(makeMsg({ isMention: true }), {})).toBe(true);
  });

  it('ignores non-mentions when no channel config exists', () => {
    expect(shouldRespond(makeMsg({ isMention: false }), {})).toBe(false);
  });

  it('responds to all messages when channel mode is "all"', () => {
    const config: PlatformConfig = {
      discord: { channels: { ch1: { mode: 'all' } } },
    };
    expect(shouldRespond(makeMsg(), config)).toBe(true);
  });

  it('only responds to mentions when channel mode is "mention"', () => {
    const config: PlatformConfig = {
      discord: { channels: { ch1: { mode: 'mention' } } },
    };
    expect(shouldRespond(makeMsg({ isMention: false }), config)).toBe(false);
    expect(shouldRespond(makeMsg({ isMention: true }), config)).toBe(true);
  });

  it('defaults to mention-only for channels not in config', () => {
    const config: PlatformConfig = {
      discord: { channels: { other: { mode: 'all' } } },
    };
    expect(shouldRespond(makeMsg({ isMention: false }), config)).toBe(false);
    expect(shouldRespond(makeMsg({ isMention: true }), config)).toBe(true);
  });

  it('defaults to mention-only when platform has no channels config', () => {
    const config: PlatformConfig = { discord: { enabled: true } };
    expect(shouldRespond(makeMsg({ isMention: false }), config)).toBe(false);
  });
});
