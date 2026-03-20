import { describe, it, expect } from 'vitest';
import { DirectoryLock } from '../session/directory-lock.js';

describe('DirectoryLock', () => {
  it('acquires and releases a lock', () => {
    const lock = new DirectoryLock();
    const result = lock.acquire('/project', 'session-1', 'user-1');
    expect(result.acquired).toBe(true);

    lock.release('/project', 'session-1');
    expect(lock.isLocked('/project')).toBe(false);
  });

  it('same session re-acquires same directory (idempotent)', () => {
    const lock = new DirectoryLock();
    lock.acquire('/project', 'session-1', 'user-1');
    const result = lock.acquire('/project', 'session-1', 'user-1');
    expect(result.acquired).toBe(true);
  });

  it('different session is blocked on same directory', () => {
    const lock = new DirectoryLock();
    lock.acquire('/project', 'session-1', 'user-1');
    const result = lock.acquire('/project', 'session-2', 'user-2');
    expect(result.acquired).toBe(false);
    expect(result.heldBy?.sessionId).toBe('session-1');
    expect(result.heldBy?.userId).toBe('user-1');
  });

  it('detects parent/child path conflicts', () => {
    const lock = new DirectoryLock();
    lock.acquire('/project', 'session-1', 'user-1');

    const child = lock.acquire('/project/src', 'session-2', 'user-2');
    expect(child.acquired).toBe(false);

    lock.release('/project', 'session-1');

    lock.acquire('/project/src', 'session-2', 'user-2');
    const parent = lock.acquire('/project', 'session-3', 'user-3');
    expect(parent.acquired).toBe(false);
  });

  it('does not conflict on similar path prefixes', () => {
    const lock = new DirectoryLock();
    lock.acquire('/project', 'session-1', 'user-1');

    const result = lock.acquire('/projects', 'session-2', 'user-2');
    expect(result.acquired).toBe(true);
  });

  it('release by wrong session ID is a no-op', () => {
    const lock = new DirectoryLock();
    lock.acquire('/project', 'session-1', 'user-1');
    lock.release('/project', 'wrong-session');
    expect(lock.isLocked('/project')).toBe(true);
  });

  it('release unblocks subsequent acquire', () => {
    const lock = new DirectoryLock();
    lock.acquire('/project', 'session-1', 'user-1');
    expect(lock.acquire('/project', 'session-2', 'user-2').acquired).toBe(false);

    lock.release('/project', 'session-1');
    expect(lock.acquire('/project', 'session-2', 'user-2').acquired).toBe(true);
  });

  it('isLocked excludes specified session', () => {
    const lock = new DirectoryLock();
    lock.acquire('/project', 'session-1', 'user-1');
    expect(lock.isLocked('/project')).toBe(true);
    expect(lock.isLocked('/project', 'session-1')).toBe(false);
  });
});
