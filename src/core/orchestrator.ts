import { Agent } from './agent.js';
import { AgentManager } from './agent-manager.js';
import { Bridge } from './bridge.js';
import type { AgentChatEvent } from './agent.js';
import type { ToolCall, ToolResult, SessionEntry } from './types.js';
import type { SessionEntry as SessionEntryType } from './types.js';

// ─── Orchestrator Events ───────────────────────────────────────

export type OrchestratorEvent =
  | { type: 'text_delta'; agentId: string; content: string }
  | { type: 'tool_call'; agentId: string; toolCall: ToolCall }
  | { type: 'tool_result'; agentId: string; toolCall: string; toolResult: ToolResult }
  | { type: 'stop'; agentId: string; content?: string; isScanner?: boolean }
  | { type: 'error'; agentId: string; content: string }
  | { type: 'routing'; from: string; to: string; task: string };

// ─── @mention Parsing ──────────────────────────────────────────

const MENTION_RE = /@(\w[\w-]*)/g;

/**
 * Parse @mentions from text. Returns unique, valid agent mentions.
 */
function parseMentions(text: string, agentManager: AgentManager): string[] {
  const mentions = new Set<string>();
  let match: RegExpExecArray | null;
  MENTION_RE.lastIndex = 0;
  while ((match = MENTION_RE.exec(text)) !== null) {
    const name = match[1]!;
    const agent = agentManager.getAgentByMention(name);
    if (agent) {
      mentions.add(agent.id);
    }
  }
  return Array.from(mentions);
}

// ─── ChatOrchestrator ──────────────────────────────────────────

/**
 * ChatOrchestrator — routes user messages to the right agent(s).
 *
 * Multi-agent routing:
 * - If user message contains @mentions → route directly to those agents
 * - If no @mentions → route to scanner (built-in routing agent)
 * - Scanner analyzes and delegates via @mentions
 * - Any agent can @mention other agents (recursive delegation)
 * - Same agent: only one concurrent instance (queued if busy)
 * - Scanner messages are internal (not shown to user directly)
 */
export class ChatOrchestrator {
  private agentManager: AgentManager;
  private bridge: Bridge;
  private scannerAgent: Agent | null = null;
  private maxRecursionDepth = 5;

  constructor(agentManager: AgentManager, bridge: Bridge) {
    this.agentManager = agentManager;
    this.bridge = bridge;
  }

  /**
   * Set the scanner agent (built-in routing agent).
   */
  setScannerAgent(agent: Agent): void {
    this.scannerAgent = agent;
  }

  /**
   * Get the scanner agent.
   */
  getScannerAgent(): Agent | null {
    return this.scannerAgent;
  }

  /**
   * Process user input and route to appropriate agent(s).
   * Async generator that yields orchestrator events for UI rendering.
   */
  async *chat(
    input: string,
    options?: { signal?: AbortSignal },
  ): AsyncGenerator<OrchestratorEvent> {
    // Check for @mentions in user input
    const userMentions = this.resolveMentions(input);

    if (options?.signal?.aborted) return;

    if (userMentions.length > 0) {
      // User explicitly @mentioned agents — route directly, skip scanner
      for (const agentId of userMentions) {
        yield { type: 'routing', from: 'user', to: agentId, task: input };
      }
      yield* this.processAgentsParallel(userMentions, input, 0, options);
    } else if (this.scannerAgent) {
      // No @mentions — route through scanner
      yield { type: 'routing', from: 'user', to: this.scannerAgent.id, task: input };
      yield* this.processWithScanner(input, 0, options);
    } else {
      // No scanner — find first available non-scanner agent
      const fallback = this.findDefaultAgent();
      if (fallback) {
        yield { type: 'routing', from: 'user', to: fallback.id, task: input };
        yield* this.forwardAgentChat(fallback, input, false, options);
      } else {
        yield { type: 'error', agentId: 'system', content: 'No agents available.' };
      }
    }
  }

  /**
   * Process user input through the scanner agent.
   * Scanner output is NOT shown to the user — it's internal routing only.
   * Only the delegated agents' output is visible.
   */
  private async *processWithScanner(
    input: string,
    depth: number,
    options?: { signal?: AbortSignal },
  ): AsyncGenerator<OrchestratorEvent> {
    if (!this.scannerAgent || depth >= this.maxRecursionDepth) return;

    const abortSignal = options?.signal;

    // Build scanner context: info about available agents
    const agentList = this.buildAgentList();
    const scannerInput = `[Available agents]\n${agentList}\n\n[User request]\n${input}\n\nAnalyze and delegate using @mentions.`;

    // Collect scanner output silently — do NOT yield text_delta to UI
    const scannerOutput = await this.collectAgentOutput(this.scannerAgent, scannerInput, abortSignal);

    // If aborted during scanner output, stop here
    if (abortSignal?.aborted) return;

    // Record scanner routing as system event for traceability
    this.scannerAgent.addSessionEntry({
      t: Date.now(),
      type: 'system_event',
      agentId: this.scannerAgent.id,
      event: 'scanner_routing',
      data: { input, output: scannerOutput },
    });

    // Parse @mentions from scanner output
    const delegateIds = this.resolveMentions(scannerOutput);

    if (delegateIds.length === 0) {
      // Scanner didn't mention anyone — no output to show
      yield { type: 'stop', agentId: this.scannerAgent.id, isScanner: true };
      return;
    }

    // Scanner delegated — route to mentioned agents (no scanner stop event shown)
    for (const agentId of delegateIds) {
      yield { type: 'routing', from: this.scannerAgent.id, to: agentId, task: scannerOutput };
    }
    yield* this.processAgentsParallel(delegateIds, scannerOutput, depth, options);
  }

  /**
   * Process multiple agents in parallel — true concurrency via Promise.race.
   * Each agent's event stream is interleaved as events arrive.
   * Agent identity is preserved via event.agentId.
   */
  private async *processAgentsParallel(
    agentIds: string[],
    context: string,
    depth: number,
    options?: { signal?: AbortSignal },
  ): AsyncGenerator<OrchestratorEvent> {
    if (depth >= this.maxRecursionDepth) {
      yield { type: 'error', agentId: 'system', content: 'Max delegation depth reached.' };
      return;
    }

    if (options?.signal?.aborted) return;

    // Resolve agents and extract tasks
    const agentTasks: Array<{ agent: import('./agent.js').Agent; task: string }> = [];
    for (const agentId of agentIds) {
      const agent = this.agentManager.getAgent(agentId);
      if (!agent) {
        yield { type: 'error', agentId, content: `Agent not found: ${agentId}` };
        continue;
      }
      const taskText = this.extractTaskForAgent(context, agent);
      agentTasks.push({ agent, task: taskText });
    }

    if (agentTasks.length === 0) return;

    // Acquire all agents first
    for (const { agent } of agentTasks) {
      await this.agentManager.acquireAgent(agent.id);
    }

    try {
      // Create async generators for each agent
      type GenEntry = { id: string; gen: AsyncGenerator<OrchestratorEvent> };
      const generators: GenEntry[] = [];

      for (const { agent, task } of agentTasks) {
        const gen = this.forwardAgentChat(agent, task, true, options);
        generators.push({ id: agent.id, gen });
      }

      // Track output text for sub-mention detection
      const outputTexts = new Map<string, string>();

      // Consume all generators in parallel via Promise.race
      const abortSignal = options?.signal;
      let pendings: Array<{
        id: string;
        promise: Promise<IteratorResult<OrchestratorEvent, void>>;
      }> = generators.map(g => ({
        id: g.id,
        promise: g.gen.next(),
      }));

      while (pendings.length > 0) {
        if (abortSignal?.aborted) break;

        const winner = await Promise.race(
          pendings.map(p => p.promise.then(result => ({ id: p.id, result }))),
        );

        if (winner.result.done) {
          pendings = pendings.filter(p => p.id !== winner.id);
          continue;
        }

        const event = winner.result.value;

        // Track text output for each agent
        if (event.type === 'text_delta') {
          const prev = outputTexts.get(winner.id) || '';
          outputTexts.set(winner.id, prev + event.content);
        }

        yield event;

        // Re-prime the consumed generator
        const gen = generators.find(g => g.id === winner.id);
        if (gen) {
          const idx = pendings.findIndex(p => p.id === winner.id);
          if (idx !== -1) {
            pendings[idx] = { id: winner.id, promise: gen.gen.next() };
          }
        }
      }

      // Check each agent's output for further @mentions (agent-to-agent delegation)
      for (const { agent } of agentTasks) {
        const text = outputTexts.get(agent.id) || '';
        if (!text) continue;
        const subMentions = this.resolveMentions(text);
        if (subMentions.length > 0) {
          for (const subId of subMentions) {
            yield { type: 'routing', from: agent.id, to: subId, task: text };
          }
          yield* this.processAgentsParallel(subMentions, text, depth + 1, options);
        }
      }
    } finally {
      // Release all agents
      for (const { agent } of agentTasks) {
        this.agentManager.markAgentFree(agent.id);
      }
    }
  }

  /**
   * Run a single agent's chat and forward all events.
   * NOTE: Agent list is NOT prepended here — only the scanner gets the agent list.
   * Delegated agents receive the task description directly.
   */
  private async *forwardAgentChat(
    agent: Agent,
    input: string,
    recordToSession: boolean,
    options?: { signal?: AbortSignal },
  ): AsyncGenerator<OrchestratorEvent> {
    // Save user message to agent's session if recording
    if (recordToSession) {
      agent.addSessionEntry({
        t: Date.now(),
        type: 'message',
        agentId: agent.id,
        role: 'user',
        content: input,
      });
    }

    const message = { role: 'user' as const, content: input };
    let buffer = '';

    try {
      for await (const event of agent.chat([message], { signal: options?.signal })) {
        switch (event.type) {
          case 'text_delta':
            buffer += event.content;
            yield { type: 'text_delta', agentId: agent.id, content: event.content };
            break;
          case 'tool_call':
            yield { type: 'tool_call', agentId: agent.id, toolCall: event.toolCall };
            break;
          case 'tool_result':
            yield { type: 'tool_result', agentId: agent.id, toolCall: event.toolCall, toolResult: event.toolResult };
            break;
          case 'stop':
            yield { type: 'stop', agentId: agent.id };
            break;
          case 'error':
            yield { type: 'error', agentId: agent.id, content: event.content };
            break;
        }
      }
    } catch (err) {
      yield { type: 'error', agentId: agent.id, content: err instanceof Error ? err.message : String(err) };
    }

    // Save assistant response to session if recording
    if (recordToSession && buffer) {
      agent.addSessionEntry({
        t: Date.now(),
        type: 'message',
        agentId: agent.id,
        role: 'assistant',
        content: buffer,
        model: agent.getState().config.model,
      });
    }
  }

  /**
   * Collect all text from an agent's chat (no UI forwarding).
   * Used for scanner — output is not shown directly.
   */
  private async collectAgentOutput(
    agent: Agent,
    input: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const message = { role: 'user' as const, content: input };
    let output = '';

    try {
      for await (const event of agent.chat([message], { signal })) {
        if (event.type === 'text_delta') {
          output += event.content;
        }
      }
    } catch {
      // silent
    }

    return output;
  }

  /**
   * Resolve @mentions in text to agent IDs.
   * Uses regex first, then falls back to simple string inclusion for robustness.
   */
  private resolveMentions(text: string): string[] {
    // First try: regex-based
    const regexIds = this.regexResolveMentions(text);
    if (regexIds.length > 0) return regexIds;

    // Fallback: simple string check against all known agent names/aliases
    return this.simpleResolveMentions(text);
  }

  /**
   * Regex-based @mention resolver.
   */
  private regexResolveMentions(text: string): string[] {
    const agentIds: string[] = [];
    const seen = new Set<string>();
    let match: RegExpExecArray | null;
    MENTION_RE.lastIndex = 0;
    while ((match = MENTION_RE.exec(text)) !== null) {
      const name = match[1]!;
      if (seen.has(name)) continue;
      seen.add(name);
      const agent = this.agentManager.getAgentByMention(name);
      if (agent && !seen.has(agent.id)) {
        seen.add(agent.id);
        agentIds.push(agent.id);
      }
    }
    return agentIds;
  }

  /**
   * Simple string-inclusion based @mention resolver.
   * Checks if text contains `@agentName` or `@alias` for any known agent.
   */
  private simpleResolveMentions(text: string): string[] {
    const agentIds: string[] = [];
    const agents = this.agentManager.listAgents();
    for (const a of agents) {
      const agent = this.agentManager.getAgent(a.id);
      if (!agent) continue;

      // Check by name
      if (text.includes(`@${agent.name}`)) {
        agentIds.push(agent.id);
        continue;
      }

      // Check by alias
      if (agent.config.alias && text.includes(`@${agent.config.alias}`)) {
        agentIds.push(agent.id);
      }
    }
    return agentIds;
  }

  /**
   * Extract the task text directed at a specific agent from context.
   * Looks for "@agentName task description" patterns.
   */
  private extractTaskForAgent(context: string, agent: Agent): string {
    const aliases = [agent.name];
    if (agent.config.alias) aliases.push(agent.config.alias);

    for (const name of aliases) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`@${escaped}[\\s,:]*([^@]*)`, 'i');
      const match = regex.exec(context);
      if (match && match[1]!.trim()) {
        return match[1]!.trim();
      }
    }

    // Fallback: return full context (remove @mentions for cleanliness)
    return context.replace(MENTION_RE, '').trim();
  }

  /**
   * Build a list of available agents for the scanner's context.
   */
  private buildAgentList(): string {
    const agents = this.agentManager.listAgents();
    return agents
      .filter(a => a.id !== this.scannerAgent?.id)
      .filter(a => a.id !== 'default')
      .map(a => {
        const desc = a.description ? `: ${a.description}` : '';
        const alias = this.agentManager.getAgent(a.id)?.config?.alias;
        const aliasStr = alias ? ` (alias: @${alias})` : '';
        return `  @${a.name}${aliasStr} — ${a.model}${desc}`;
      })
      .join('\n');
  }

  /**
   * Find the first non-scanner default agent.
   */
  private findDefaultAgent(): Agent | undefined {
    const agents = this.agentManager.listAgents();
    for (const a of agents) {
      if (a.id !== this.scannerAgent?.id) {
        return this.agentManager.getAgent(a.id);
      }
    }
    return this.agentManager.getDefaultAgent();
  }
}
