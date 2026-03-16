import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RateLimiter } from '../rate-limiter.js';

describe('RateLimiter', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('allows requests within limit', () => {
    const limiter = new RateLimiter({ admin: 5, chat: 2 });
    expect(limiter.tryAcquire('user1', 'admin')).toBe(true);
    expect(limiter.tryAcquire('user1', 'admin')).toBe(true);
    expect(limiter.tryAcquire('user1', 'admin')).toBe(true);
  });

  it('rejects requests exceeding limit', () => {
    const limiter = new RateLimiter({ admin: 2, chat: 1 });
    expect(limiter.tryAcquire('user1', 'chat')).toBe(true);
    expect(limiter.tryAcquire('user1', 'chat')).toBe(false);
  });

  it('resets after one minute', () => {
    const limiter = new RateLimiter({ admin: 1, chat: 1 });
    expect(limiter.tryAcquire('user1', 'admin')).toBe(true);
    expect(limiter.tryAcquire('user1', 'admin')).toBe(false);
    vi.advanceTimersByTime(60_000);
    expect(limiter.tryAcquire('user1', 'admin')).toBe(true);
  });

  it('tracks users independently', () => {
    const limiter = new RateLimiter({ admin: 1, chat: 1 });
    expect(limiter.tryAcquire('user1', 'admin')).toBe(true);
    expect(limiter.tryAcquire('user2', 'admin')).toBe(true);
  });
});
