import { SystemEvent, SystemEventType } from './types.js';

type EventHandler = (event: SystemEvent) => void | Promise<void>;

/**
 * EventBus — typed pub/sub for system-level events.
 *
 * Used for observability, hooks, and decoupling between subsystems.
 * This is NOT the Bridge (which handles agent-to-agent communication).
 * The EventBus handles infrastructure events.
 */
export class EventBus {
  private handlers = new Map<SystemEventType, Set<EventHandler>>();
  private history: SystemEvent[] = [];
  private maxHistory = 1000;

  /**
   * Subscribe to a specific event type.
   * Returns an unsubscribe function.
   */
  on(type: SystemEventType, handler: EventHandler): () => void {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, new Set());
    }
    this.handlers.get(type)!.add(handler);

    return () => {
      this.handlers.get(type)?.delete(handler);
    };
  }

  /**
   * Subscribe to ALL events (for logging, monitoring).
   */
  onAny(handler: EventHandler): () => void {
    const allTypes: SystemEventType[] = [
      'agent:spawned', 'agent:status_change', 'agent:error', 'agent:response',
      'tool:called', 'tool:result', 'session:save', 'session:load',
      'user:input', 'bridge:message', 'config:change', 'system:error',
    ];
    const unsubs = allTypes.map(type => this.on(type, handler));
    return () => unsubs.forEach(fn => fn());
  }

  /**
   * Emit an event to all subscribers.
   */
  async emit(type: SystemEventType, data: unknown, agentId?: string): Promise<void> {
    const event: SystemEvent = {
      type,
      timestamp: Date.now(),
      agentId,
      data,
    };

    // store in history ring buffer
    this.history.push(event);
    if (this.history.length > this.maxHistory) {
      this.history.shift();
    }

    // dispatch to handlers
    const handlers = this.handlers.get(type);
    if (handlers) {
      const promises: Promise<void>[] = [];
      for (const handler of handlers) {
        promises.push(Promise.resolve(handler(event)));
      }
      await Promise.allSettled(promises);
    }
  }

  /**
   * Get recent event history (for debugging, session save).
   */
  getHistory(limit = 100): SystemEvent[] {
    return this.history.slice(-limit);
  }

  /**
   * Clear event history.
   */
  clearHistory(): void {
    this.history = [];
  }
}
