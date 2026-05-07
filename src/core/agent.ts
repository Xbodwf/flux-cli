import {
  AgentConfig,
  AgentState,
  AgentStatus,
  Message,
  SessionEntry,
  SystemEventType,
  ToolCall,
  ToolResult,
} from './types.js';
import { EventBus } from './event-bus.js';
import { buildSystemPrompt } from './prompt-loader.js';
import { LLMProvider, ChatOptions } from '../llm/base.js';
import { ToolRegistry } from '../tools/registry.js';

export type AgentChatEvent =
  | { type: 'text_delta'; content: string }
  | { type: 'tool_call'; toolCall: ToolCall }
  | { type: 'tool_result'; toolCall: string; toolResult: ToolResult }
  | { type: 'stop'; content?: string }
  | { type: 'error'; content: string };

/**
 * Agent — the fundamental execution unit in Flux.
 *
 * Each agent is an independent actor with its own LLM provider,
 * persona, tool registry, and conversation session. Agents can
 * operate solo (user ↔ agent) or participate in a Bridge topology
 * (multi-agent coordination).
 */
export class Agent {
  readonly id: string;
  readonly name: string;
  readonly config: AgentConfig;

  private provider: LLMProvider;
  private tools: ToolRegistry;
  private bus: EventBus;
  private state: AgentState;
  private abortController: AbortController | null = null;

  constructor(
    config: AgentConfig,
    provider: LLMProvider,
    tools: ToolRegistry,
    bus: EventBus,
  ) {
    this.id = config.id;
    this.name = config.name;
    this.config = config;
    this.provider = provider;
    this.tools = tools;
    this.bus = bus;

    this.state = {
      config,
      status: 'idle',
      session: [],
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
    };
  }

  get status(): AgentStatus {
    return this.state.status;
  }

  get session(): SessionEntry[] {
    return this.state.session;
  }

  get lastActiveAt(): number {
    return this.state.lastActiveAt;
  }

  /**
   * Send a message to this agent and stream the response.
   *
   * The agent will:
   * 1. Run the LLM with conversation history
   * 2. Stream text deltas back
   * 3. Handle tool calls automatically (loop until completion)
   * 4. Yield stop signal when done
   */
  async *chat(
    messages: Message[],
    options?: { signal?: AbortSignal },
  ): AsyncGenerator<AgentChatEvent> {
    this.setState('thinking');
    this.abortController = new AbortController();
    const signal = options?.signal
      ? AbortSignal.any([options.signal, this.abortController.signal])
      : this.abortController.signal;

    try {
      // Merge system prompt from persona
      const chatOptions: ChatOptions = {
        system: buildSystemPrompt(this.config.persona.prompt),
        tools: this.getAvailableTools(),
        maxTokens: this.config.maxTokens,
        temperature: this.config.temperature ?? this.config.persona.temperature,
        signal,
      };

      // Convert session history + new messages to provider format
      const fullHistory = this.buildMessageHistory(messages);

      // Main generation loop
      let done = false;
      while (!done) {
        let toolCalledThisRound = false;
        const stream = this.provider.chat(fullHistory, chatOptions);

        for await (const event of stream) {
          switch (event.type) {
            case 'text_delta':
              yield { type: 'text_delta', content: event.delta };
              break;

            case 'tool_call': {
              const tc = event.toolCall!;
              toolCalledThisRound = true;
              yield { type: 'tool_call', toolCall: tc };
              this.setState('awaiting_tools');

              // Execute tool
              const result = await this.executeTool(tc);

              yield { type: 'tool_result', toolCall: tc.id, toolResult: result };
              this.setState('thinking');

              // Add tool result to history for next LLM turn
              fullHistory.push({
                role: 'assistant',
                content: [{ type: 'tool_use', id: tc.id, name: tc.name, input: tc.args as Record<string, unknown> }],
              });
              fullHistory.push({
                role: 'user',
                content: [{ type: 'tool_result', toolUseId: tc.id, content: JSON.stringify(result.content) }],
              });

              // Persist to session so tool context survives across user turns
              this.state.session.push({
                t: Date.now(),
                type: 'tool_call',
                agentId: this.id,
                toolCall: tc,
              });
              this.state.session.push({
                t: Date.now(),
                type: 'tool_result',
                agentId: this.id,
                toolCall: tc,
                toolResult: result,
              });
              break;
            }

            case 'stop':
              // Only truly done when the LLM finished without calling tools
              if (!toolCalledThisRound) {
                done = true;
                yield { type: 'stop', content: event.stopReason };
              }
              break;

            case 'error':
              yield { type: 'error', content: event.error };
              this.setState('error', event.error);
              return;
          }
        }
      }

      this.setState('done');
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.setState('error', errorMsg);
      yield { type: 'error', content: errorMsg };
    } finally {
      this.abortController = null;
    }
  }

  /**
   * Interrupt the current generation.
   */
  abort(): void {
    this.abortController?.abort();
  }

  /**
   * Get snapshot of current agent state.
   */
  getState(): AgentState {
    return { ...this.state, session: [...this.state.session] };
  }

  /**
   * Switch the model used by this agent at runtime.
   * Updates both the config and the underlying provider.
   */
  setModel(model: string): void {
    this.config.model = model;
    this.provider.model = model;
  }

  /**
   * Restore agent state from a saved snapshot.
   */
  restoreState(state: AgentState): void {
    this.state = { ...state };
  }

  private setState(status: AgentStatus, error?: string): void {
    this.state.status = status;
    this.state.lastActiveAt = Date.now();
    if (error) this.state.error = error;

    this.bus.emit('agent:status_change', { agentId: this.id, status, error });
  }

  private getAvailableTools() {
    return this.config.tools
      .map(name => this.tools.get(name))
      .filter((t): t is NonNullable<typeof t> => t !== undefined);
  }

  private async executeTool(toolCall: ToolCall): Promise<ToolResult> {
    const tool = this.tools.get(toolCall.name);
    if (!tool) {
      return {
        content: [{ type: 'error', data: `Unknown tool: ${toolCall.name}` }],
        isError: true,
      };
    }

    this.bus.emit('tool:called', { agentId: this.id, toolCall } as any);

    try {
      const result = await tool.handler(toolCall.args);
      this.bus.emit('tool:result', { agentId: this.id, toolCall, result } as any);
      return result;
    } catch (err) {
      const errorResult: ToolResult = {
        content: [{ type: 'error', data: err instanceof Error ? err.message : String(err) }],
        isError: true,
      };
      this.bus.emit('tool:result', { agentId: this.id, toolCall, result: errorResult } as any);
      return errorResult;
    }
  }

  private buildMessageHistory(newMessages: Message[]): Message[] {
    // Only include the most recent N session entries to keep context lean.
    // The agent can use memory_search to recall older context when needed.
    const maxEntries = this.config.maxHistoryEntries ?? 30;
    const recentSession = this.state.session.slice(-maxEntries);

    // Convert session entries to message format
    const history: Message[] = [];
    for (const entry of recentSession) {
      if (entry.type === 'tool_call' && entry.toolCall) {
        history.push({
          role: 'assistant',
          content: [{
            type: 'tool_use',
            id: entry.toolCall.id,
            name: entry.toolCall.name,
            input: entry.toolCall.args as Record<string, unknown>,
          }],
        });
      } else if (entry.type === 'tool_result' && entry.toolResult && entry.toolCall) {
        history.push({
          role: 'user',
          content: [{
            type: 'tool_result',
            toolUseId: entry.toolCall.id,
            content: JSON.stringify(entry.toolResult.content),
          }],
        });
      } else if (entry.type === 'message' && entry.role) {
        if (entry.content === null || entry.content === undefined) continue;
        const msg: Message = {
          role: entry.role,
          content: entry.content,
        };
        if (entry.toolCall) msg.toolCalls = [entry.toolCall];
        history.push(msg);
      }
    }

    // Append new messages
    history.push(...newMessages);

    return history;
  }

  /**
   * Add an entry to this agent's session history.
   * Called externally after generation completes.
   */
  addSessionEntry(entry: SessionEntry): void {
    this.state.session.push(entry);
  }
}
