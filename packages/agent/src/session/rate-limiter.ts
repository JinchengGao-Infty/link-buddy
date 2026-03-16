export type RoleLimits = Record<string, number>;

interface BucketEntry {
  count: number;
  windowStart: number;
}

const WINDOW_MS = 60_000;

export class RateLimiter {
  private readonly limits: RoleLimits;
  // Key: `${userId}:${role}`
  private readonly buckets = new Map<string, BucketEntry>();

  constructor(limits: RoleLimits) {
    this.limits = limits;
  }

  tryAcquire(userId: string, role: string): boolean {
    const limit = this.limits[role];
    if (limit === undefined) {
      // Unknown role — deny by default
      return false;
    }

    const key = `${userId}:${role}`;
    const now = Date.now();
    const bucket = this.buckets.get(key);

    if (bucket === undefined || now - bucket.windowStart >= WINDOW_MS) {
      // Start a fresh window
      this.buckets.set(key, { count: 1, windowStart: now });
      return true;
    }

    if (bucket.count < limit) {
      bucket.count += 1;
      return true;
    }

    return false;
  }
}
