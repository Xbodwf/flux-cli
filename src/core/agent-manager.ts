import { EventBus } from './event-bus.js';
import { Agent } from './agent.js';
import { Bridge } from './bridge.js';
import { createProvider } from '../llm/provider.js';
import { ToolRegistry } from '../tools/registry.js';
import { loadConfig } from '../config/loader.js';
import type { AgentConfig, ProviderType } from './types.js';

/**
 * AgentManager — handles agent lifecycle.
 *
 * Creates, lists, inspects, and destroys agents.
 * Each agent gets its own LLM provider instance and tool registry view.
 */
export class AgentManager {
  private agents = new Map<string, Agent>();
  private busyAgents = new Set<string>();   // agents currently processing
  private pendingQueue: Array<{ agentId: string; task: string; resolve: () => void }> = [];
  private bus: EventBus;
  private bridge: Bridge;
  private toolRegistry: ToolRegistry;

  constructor(bus: EventBus, bridge: Bridge, toolRegistry: ToolRegistry) {
    this.bus = bus;
    this.bridge = bridge;
    this.toolRegistry = toolRegistry;
  }

  /**
   * Create a new agent.
   */
  async createAgent(config: AgentConfig): Promise<Agent> {
    const fluxConfig = loadConfig();

    // Resolve provider config
    const providerConfig = fluxConfig.providers[config.provider];
    const model = config.model || providerConfig?.defaultModel || fluxConfig.defaultModel;

    // Create provider
    const provider = createProvider(config.provider, {
      apiKey: providerConfig?.apiKey,
      baseUrl: providerConfig?.baseUrl,
      defaultModel: model,
    });

    // Make sure provider model matches
    provider.model = model;

    // Create agent
    const agent = new Agent(config, provider, this.toolRegistry, this.bus);

    // Register
    this.agents.set(agent.id, agent);
    this.bridge.register(agent);

    await this.bus.emit('agent:spawned', {
      agentId: agent.id,
      name: agent.name,
      provider: config.provider,
      model,
    });

    return agent;
  }

  /**
   * Destroy an agent.
   */
  async destroyAgent(agentId: string): Promise<boolean> {
    const agent = this.agents.get(agentId);
    if (!agent) return false;

    agent.abort();
    this.bridge.unregister(agentId);
    this.agents.delete(agentId);

    await this.bus.emit('agent:spawned', {
      agentId,
      event: 'destroyed',
    });

    return true;
  }

  /**
   * Get an agent by ID.
   */
  getAgent(agentId: string): Agent | undefined {
    return this.agents.get(agentId);
  }

  /**
   * Get the default agent (first one created, or creates one).
   */
  getDefaultAgent(): Agent | undefined {
    if (this.agents.size === 0) return undefined;
    return this.agents.values().next().value;
  }

  /**
   * List all agents.
   */
  listAgents(): Array<{ id: string; name: string; provider: ProviderType; model: string; status: string }> {
    return Array.from(this.agents.values()).map(a => ({
      id: a.id,
      name: a.name,
      provider: a.config.provider,
      model: a.config.model,
      status: a.status,
    }));
  }

  /**
   * Get an agent by name, alias, or id.
   * Checks: id → name → alias
   */
  getAgentByName(name: string): Agent | undefined {
    // Direct id match
    const byId = this.agents.get(name);
    if (byId) return byId;

    // Name match
    for (const agent of this.agents.values()) {
      if (agent.name === name) return agent;
    }

    // Alias match
    for (const agent of this.agents.values()) {
      if (agent.config.alias === name) return agent;
    }

    return undefined;
  }

  /**
   * Get an agent by alias only.
   */
  getAgentByAlias(alias: string): Agent | undefined {
    for (const agent of this.agents.values()) {
      if (agent.config.alias === alias) return agent;
    }
    return undefined;
  }

  /**
   * Resolve @mention to an agent.
   * Tries name first, then alias.
   */
  getAgentByMention(mention: string): Agent | undefined {
    return this.getAgentByName(mention);
  }

  /**
   * Check if an agent is currently busy processing.
   */
  isAgentBusy(agentId: string): boolean {
    return this.busyAgents.has(agentId);
  }

  /**
   * Mark an agent as busy (started processing).
   */
  markAgentBusy(agentId: string): void {
    this.busyAgents.add(agentId);
  }

  /**
   * Mark an agent as free (finished processing).
   * Processes any queued tasks for this agent.
   */
  markAgentFree(agentId: string): void {
    this.busyAgents.delete(agentId);
    // Process next queued task for this agent
    const idx = this.pendingQueue.findIndex(q => q.agentId === agentId);
    if (idx !== -1) {
      const queued = this.pendingQueue.splice(idx, 1)[0]!;
      queued.resolve();
    }
  }

  /**
   * Wait until an agent is free, then mark it busy.
   * Returns immediately if already free.
   */
  async acquireAgent(agentId: string): Promise<void> {
    if (!this.busyAgents.has(agentId)) {
      this.busyAgents.add(agentId);
      return;
    }
    // Queue — will be resolved by markAgentFree
    return new Promise<void>(resolve => {
      this.pendingQueue.push({ agentId, task: 'acquire', resolve });
    });
  }

  /**
   * Get count of active agents.
   */
  get agentCount(): number {
    return this.agents.size;
  }
}
