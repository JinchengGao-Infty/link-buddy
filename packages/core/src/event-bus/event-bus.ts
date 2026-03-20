import type { EventBus, EventMap, Disposable } from '../types/index.js';

export function createEventBus(): EventBus {
  const listeners = new Map<string, Set<(payload: any) => void | Promise<void>>>();

  return {
    async publish<K extends keyof EventMap>(event: K, payload: EventMap[K]): Promise<void> {
      const handlers = listeners.get(event as string);
      if (!handlers) return;
      for (const handler of handlers) {
        try {
          await Promise.resolve(handler(payload));
        } catch (err) {
          console.error(`EventBus: handler error for "${event as string}":`, err);
        }
      }
    },

    subscribe<K extends keyof EventMap>(
      event: K,
      handler: (payload: EventMap[K]) => void | Promise<void>,
    ): Disposable {
      const key = event as string;
      if (!listeners.has(key)) {
        listeners.set(key, new Set());
      }
      const handlers = listeners.get(key)!;
      handlers.add(handler as any);
      return {
        dispose() {
          handlers.delete(handler as any);
          if (handlers.size === 0) {
            listeners.delete(key);
          }
        },
      };
    },
  };
}
