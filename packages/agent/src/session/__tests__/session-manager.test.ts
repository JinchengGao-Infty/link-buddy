import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SessionManager } from '../session-manager.js';

describe('SessionManager', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('creates a new session', () => {
    const mgr = new SessionManager({ timeoutMinutes: 30, cleanupHours: 24 });
    const session = mgr.getOrCreate('dad-discord-dev');
    expect(session.id).toBe('dad-discord-dev');
    expect(session.status).toBe('active');
  });

  it('returns existing session on second call', () => {
    const mgr = new SessionManager({ timeoutMinutes: 30, cleanupHours: 24 });
    const s1 = mgr.getOrCreate('dad-discord-dev');
    const s2 = mgr.getOrCreate('dad-discord-dev');
    expect(s1).toBe(s2);
  });

  it('marks session idle after timeout', () => {
    const mgr = new SessionManager({ timeoutMinutes: 30, cleanupHours: 24 });
    mgr.getOrCreate('dad-discord-dev');
    vi.advanceTimersByTime(31 * 60_000);
    mgr.tick();
    expect(mgr.get('dad-discord-dev')?.status).toBe('idle');
  });

  it('reactivates idle session on touch', () => {
    const mgr = new SessionManager({ timeoutMinutes: 30, cleanupHours: 24 });
    mgr.getOrCreate('dad-discord-dev');
    vi.advanceTimersByTime(31 * 60_000);
    mgr.tick();
    expect(mgr.get('dad-discord-dev')?.status).toBe('idle');
    mgr.touch('dad-discord-dev');
    expect(mgr.get('dad-discord-dev')?.status).toBe('active');
  });

  it('cleans up sessions after cleanup period', () => {
    const mgr = new SessionManager({ timeoutMinutes: 1, cleanupHours: 1 });
    mgr.getOrCreate('dad-discord-dev');
    vi.advanceTimersByTime(2 * 60_000);
    mgr.tick();
    vi.advanceTimersByTime(61 * 60_000);
    mgr.tick();
    expect(mgr.get('dad-discord-dev')).toBeUndefined();
  });

  it('lists active sessions', () => {
    const mgr = new SessionManager({ timeoutMinutes: 30, cleanupHours: 24 });
    mgr.getOrCreate('dad-discord-dev');
    mgr.getOrCreate('son-telegram-dm');
    expect(mgr.getActiveSessions()).toHaveLength(2);
  });
});
