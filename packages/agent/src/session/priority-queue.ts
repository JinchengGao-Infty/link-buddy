export type QueuePriority = 'admin' | 'system' | 'chat';

const PRIORITY_ORDER: Record<QueuePriority, number> = {
  admin: 0,
  system: 1,
  chat: 2,
};

interface QueueEntry<T> {
  item: T;
  priority: number;
  sequence: number;
}

export class PriorityQueue<T> {
  private readonly maxDepth: number;
  private readonly entries: QueueEntry<T>[] = [];
  private sequence = 0;

  constructor(maxDepth: number) {
    this.maxDepth = maxDepth;
  }

  get size(): number {
    return this.entries.length;
  }

  enqueue(item: T, priority: QueuePriority): boolean {
    if (this.entries.length >= this.maxDepth) {
      return false;
    }

    const priorityValue = PRIORITY_ORDER[priority];
    this.entries.push({ item, priority: priorityValue, sequence: this.sequence++ });
    return true;
  }

  dequeue(): T | undefined {
    if (this.entries.length === 0) {
      return undefined;
    }

    // Find the entry with the lowest priority value (highest priority),
    // breaking ties by lowest sequence (FIFO).
    let bestIndex = 0;
    for (let i = 1; i < this.entries.length; i++) {
      const current = this.entries[i]!;
      const best = this.entries[bestIndex]!;
      if (
        current.priority < best.priority ||
        (current.priority === best.priority && current.sequence < best.sequence)
      ) {
        bestIndex = i;
      }
    }

    const [entry] = this.entries.splice(bestIndex, 1);
    return entry!.item;
  }
}
