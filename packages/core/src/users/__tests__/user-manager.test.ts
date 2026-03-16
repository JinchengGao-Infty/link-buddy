import { describe, it, expect } from 'vitest';
import { UserManager } from '../user-manager.js';
import type { UserConfig } from '../../config/schema.js';

const testUsers: UserConfig[] = [
  { name: 'Dad', role: 'admin', discord_id: '111', telegram_id: '222' },
  { name: 'Son', role: 'chat', discord_id: '333', telegram_id: '444' },
];

describe('UserManager', () => {
  it('finds user by discord ID', () => {
    const mgr = new UserManager(testUsers);
    const user = mgr.findByPlatformId('discord', '111');
    expect(user).toBeDefined();
    expect(user!.name).toBe('Dad');
    expect(user!.role).toBe('admin');
  });

  it('finds user by telegram ID', () => {
    const mgr = new UserManager(testUsers);
    const user = mgr.findByPlatformId('telegram', '444');
    expect(user).toBeDefined();
    expect(user!.name).toBe('Son');
  });

  it('returns undefined for unknown platform ID', () => {
    const mgr = new UserManager(testUsers);
    expect(mgr.findByPlatformId('discord', '999')).toBeUndefined();
  });

  it('returns undefined for unknown platform', () => {
    const mgr = new UserManager(testUsers);
    expect(mgr.findByPlatformId('whatsapp', '111')).toBeUndefined();
  });

  it('resolves cross-platform identity', () => {
    const mgr = new UserManager(testUsers);
    const fromDiscord = mgr.findByPlatformId('discord', '111');
    const fromTelegram = mgr.findByPlatformId('telegram', '222');
    expect(fromDiscord!.name).toBe(fromTelegram!.name);
  });

  it('generates session ID from user, platform, channel', () => {
    const mgr = new UserManager(testUsers);
    const sessionId = mgr.buildSessionId('Dad', 'discord', 'dev-channel');
    expect(sessionId).toBe('dad-discord-dev-channel');
  });
});
