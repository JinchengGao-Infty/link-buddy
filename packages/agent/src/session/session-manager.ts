export interface Session {
  id: string;
  status: 'active' | 'idle';
  lastActivity: number;
  idleSince?: number;
}

export interface SessionManagerOptions {
  timeoutMinutes: number;
  cleanupHours: number;
}

export class SessionManager {
  private readonly options: SessionManagerOptions;
  private readonly sessions = new Map<string, Session>();

  constructor(options: SessionManagerOptions) {
    this.options = options;
  }

  getOrCreate(id: string): Session {
    const existing = this.sessions.get(id);
    if (existing !== undefined) {
      if (existing.status === 'idle') {
        existing.status = 'active';
        existing.lastActivity = Date.now();
        existing.idleSince = undefined;
      }
      return existing;
    }

    const session: Session = {
      id,
      status: 'active',
      lastActivity: Date.now(),
    };
    this.sessions.set(id, session);
    return session;
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  touch(id: string): void {
    const session = this.sessions.get(id);
    if (session === undefined) return;
    session.lastActivity = Date.now();
    if (session.status === 'idle') {
      session.status = 'active';
      session.idleSince = undefined;
    }
  }

  tick(): void {
    const now = Date.now();
    const timeoutMs = this.options.timeoutMinutes * 60_000;
    const cleanupMs = this.options.cleanupHours * 3_600_000;

    for (const [id, session] of this.sessions) {
      if (session.status === 'active') {
        if (now - session.lastActivity > timeoutMs) {
          session.status = 'idle';
          session.idleSince = now;
        }
      } else if (session.status === 'idle') {
        if (session.idleSince !== undefined && now - session.idleSince > cleanupMs) {
          this.sessions.delete(id);
        }
      }
    }
  }

  getActiveSessions(): Session[] {
    return Array.from(this.sessions.values()).filter(s => s.status === 'active');
  }

  remove(id: string): void {
    this.sessions.delete(id);
  }
}
