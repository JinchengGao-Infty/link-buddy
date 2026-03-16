import { describe, it, expect } from 'vitest';
import { PriorityQueue } from '../priority-queue.js';

describe('PriorityQueue', () => {
  it('dequeues admin before chat', () => {
    const queue = new PriorityQueue<string>(10);
    queue.enqueue('chat-request', 'chat');
    queue.enqueue('admin-request', 'admin');
    expect(queue.dequeue()).toBe('admin-request');
    expect(queue.dequeue()).toBe('chat-request');
  });

  it('maintains FIFO within same priority', () => {
    const queue = new PriorityQueue<string>(10);
    queue.enqueue('first', 'admin');
    queue.enqueue('second', 'admin');
    queue.enqueue('third', 'admin');
    expect(queue.dequeue()).toBe('first');
    expect(queue.dequeue()).toBe('second');
    expect(queue.dequeue()).toBe('third');
  });

  it('returns undefined when empty', () => {
    const queue = new PriorityQueue<string>(10);
    expect(queue.dequeue()).toBeUndefined();
  });

  it('rejects when max depth exceeded', () => {
    const queue = new PriorityQueue<string>(2);
    expect(queue.enqueue('a', 'chat')).toBe(true);
    expect(queue.enqueue('b', 'chat')).toBe(true);
    expect(queue.enqueue('c', 'chat')).toBe(false);
  });

  it('reports size correctly', () => {
    const queue = new PriorityQueue<string>(10);
    expect(queue.size).toBe(0);
    queue.enqueue('a', 'admin');
    expect(queue.size).toBe(1);
    queue.dequeue();
    expect(queue.size).toBe(0);
  });
});
