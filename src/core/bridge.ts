import { BridgeMessage, BridgeRoute, Message } from './types.js';
import { EventBus } from './event-bus.js';
import { Agent } from './agent.js';

type BridgeEventListener = (msg: BridgeMessage) => void;

/**
 * Bridge — multi-agent coordination bus.
 *
 * The Bridge enables agents to communicate with each other, not just
 * with the user. This is Weave's primary innovation over existing AI CLI tools.
 *
 * Three communication modes:
 * - Direct: agent-to-agent (e.g., Architect → Coder)
 * - Broadcast: one-to-all (e.g., status updates)
 * - Topic: pub/sub on named channels (e.g., #review, #design)
 *
 * The Bridge is SEPARATE from the EventBus. The EventBus handles
 * infrastructure events (agent lifecycle, tool calls, etc.). The Bridge
 * handles agent-to-agent semantic communication.
 */
export class Bridge {
  private agents = new Map<string, Agent>();
  private routes: BridgeRoute[] = [];
  private listeners = new Set<BridgeEventListener>();
  private messageLog: BridgeMessage[] = [];
  private maxLogSize = 1000;
  private bus: EventBus;

  constructor(bus: EventBus) {
    this.bus = bus;
  }

  /**
   * Register an agent with the bridge.
   */
  register(agent: Agent): void {
    this.agents.set(agent.id, agent);
  }

  /**
   * Unregister an agent.
   */
  unregister(agentId: string): void {
    this.agents.delete(agentId);
  }

  /**
   * Send a message through the bridge.
   *
   * The message is routed based on:
   * 1. Direct messages go to the specified recipient
   * 2. Broadcasts go to all agents (except sender)
   * 3. Topic messages go to subscribers of that topic
   *
   * Routes are also evaluated for directed delivery.
   */
  async send(msg: BridgeMessage): Promise<void> {
    // Log the message
    this.messageLog.push(msg);
    if (this.messageLog.length > this.maxLogSize) {
      this.messageLog.shift();
    }

    // Emit to event bus for observability
    await this.bus.emit('bridge:message', msg);

    // Determine recipients
    const recipients = this.resolveRecipients(msg);

    // Deliver to each recipient
    for (const agentId of recipients) {
      const agent = this.agents.get(agentId);
      if (!agent) continue;

      // Wrap the bridge message as an agent message
      const agentMessage: Message = {
        role: 'user',
        content: `[Bridge message from ${msg.from}]: ${msg.content}`,
        name: msg.from,
      };

      // Store in recipient's session
      agent.addSessionEntry({
        t: msg.timestamp,
        type: 'message',
        agentId: agent.id,
        role: 'user',
        content: agentMessage.content,
        event: `bridge:${msg.type}`,
        data: { from: msg.from },
      });

      // Notify listeners
      for (const listener of this.listeners) {
        listener(msg);
      }
    }
  }

  /**
   * Add a routing rule.
   */
  addRoute(route: BridgeRoute): void {
    this.routes.push(route);
  }

  /**
   * Remove a routing rule.
   */
  removeRoute(from: string, to: string, topic?: string): void {
    this.routes = this.routes.filter(
      r => !(r.from === from && r.to === to && r.topic === topic),
    );
  }

  /**
   * Listen for all bridge messages.
   */
  onMessage(callback: BridgeEventListener): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  /**
   * Get a specific agent by ID.
   */
  getAgent(agentId: string): Agent | undefined {
    return this.agents.get(agentId);
  }

  /**
   * List all registered agents.
   */
  listAgents(): Agent[] {
    return Array.from(this.agents.values());
  }

  /**
   * List all active routes.
   */
  listRoutes(): BridgeRoute[] {
    return [...this.routes];
  }

  /**
   * Get recent bridge message history.
   */
  getMessageLog(count = 50): BridgeMessage[] {
    return this.messageLog.slice(-count);
  }

  /**
   * Get the current bridge topology summary.
   */
  getTopology(): {
    agents: Array<{ id: string; name: string; status: string }>;
    routes: BridgeRoute[];
    messageCount: number;
  } {
    return {
      agents: Array.from(this.agents.values()).map(a => ({
        id: a.id,
        name: a.name,
        status: a.status,
      })),
      routes: [...this.routes],
      messageCount: this.messageLog.length,
    };
  }

  private resolveRecipients(msg: BridgeMessage): Set<string> {
    const recipients = new Set<string>();

    switch (msg.type) {
      case 'direct': {
        // Direct message: check routes first, then use explicit `to`
        const matchingRoutes = this.routes.filter(
          r => r.from === msg.from || r.from === '*',
        );

        for (const route of matchingRoutes) {
          if (!route.topic || route.topic === msg.topic) {
            if (route.to === '*') {
              // Send to all except sender
              for (const [id] of this.agents) {
                if (id !== msg.from) recipients.add(id);
              }
            } else {
              recipients.add(route.to);
            }
          }
        }

        // If no routes matched, use explicit `to`
        if (recipients.size === 0 && msg.to) {
          recipients.add(msg.to);
        }
        break;
      }

      case 'broadcast': {
        for (const [id] of this.agents) {
          if (id !== msg.from) recipients.add(id);
        }
        break;
      }

      case 'topic': {
        const topicRoutes = this.routes.filter(
          r => r.topic === msg.topic || r.topic === '*',
        );
        for (const route of topicRoutes) {
          if (route.to === '*') {
            for (const [id] of this.agents) {
              if (id !== msg.from) recipients.add(id);
            }
          } else {
            recipients.add(route.to);
          }
        }
        // Also deliver to agents subscribed to the topic
        for (const [id, agent] of this.agents) {
          if (id !== msg.from) {
            // Check if agent has topic-based routing
            const hasTopicRoute = this.routes.some(
              r => r.to === id && (r.topic === msg.topic || r.topic === '*'),
            );
            if (hasTopicRoute) recipients.add(id);
          }
        }
        break;
      }
    }

    return recipients;
  }
}
