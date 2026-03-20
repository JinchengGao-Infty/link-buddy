import { resolve, sep } from 'node:path';

export interface LockHolder {
  sessionId: string;
  userId: string;
}

export interface AcquireResult {
  acquired: boolean;
  heldBy?: LockHolder;
}

export class DirectoryLock {
  private readonly locks = new Map<string, LockHolder>();

  acquire(dir: string, sessionId: string, userId: string): AcquireResult {
    const normalized = resolve(dir);

    // Check for conflicts (same dir, parent, or child)
    for (const [lockedDir, holder] of this.locks) {
      if (holder.sessionId === sessionId) continue; // same session — no conflict
      if (this.pathsConflict(normalized, lockedDir)) {
        return { acquired: false, heldBy: holder };
      }
    }

    // Acquire or re-acquire
    this.locks.set(normalized, { sessionId, userId });
    return { acquired: true };
  }

  release(dir: string, sessionId: string): void {
    const normalized = resolve(dir);
    const holder = this.locks.get(normalized);
    if (holder && holder.sessionId === sessionId) {
      this.locks.delete(normalized);
    }
  }

  isLocked(dir: string, excludeSessionId?: string): boolean {
    const normalized = resolve(dir);
    for (const [lockedDir, holder] of this.locks) {
      if (excludeSessionId && holder.sessionId === excludeSessionId) continue;
      if (this.pathsConflict(normalized, lockedDir)) {
        return true;
      }
    }
    return false;
  }

  private pathsConflict(a: string, b: string): boolean {
    return a === b || a.startsWith(b + sep) || b.startsWith(a + sep);
  }
}
