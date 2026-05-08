// ─── Provider Types ───────────────────────────────────────────

export type ProviderType = 'anthropic' | 'openai' | 'google' | 'ollama' | 'openai-compatible';

export interface ProviderConfig {
  type: ProviderType;
  apiKey?: string;
  baseUrl?: string;
  defaultModel: string;
  fallbackModel?: string;
}

// ─── Stream Events ────────────────────────────────────────────

export type StreamEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_call'; toolCall: ToolCall }
  | { type: 'tool_result'; toolCallId: string; result: ToolResult }
  | { type: 'stop'; stopReason: 'end_turn' | 'max_tokens' | 'tool_use' | 'error' }
  | { type: 'error'; error: string };

// ─── Messages ─────────────────────────────────────────────────

export type MessageRole = 'user' | 'assistant' | 'system';

export interface Message {
  role: MessageRole;
  content: string | ContentBlock[];
  name?: string;        // agent name for multi-agent routing
  toolCalls?: ToolCall[];
  meta?: MessageMeta;
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: string };

export interface MessageMeta {
  model: string;
  tokensIn: number;
  tokensOut: number;
  timestamp: number;
  agentId: string;
}

// ─── Tools ────────────────────────────────────────────────────

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: unknown) => Promise<ToolResult>;
}

export interface ToolCall {
  id: string;
  name: string;
  args: unknown;
}

export interface ToolResult {
  content: Array<{ type: 'text' | 'image' | 'error'; data: string }>;
  isError?: boolean;
  meta?: Record<string, unknown>;
}

// ─── Agent ────────────────────────────────────────────────────

export type AgentStatus = 'idle' | 'thinking' | 'awaiting_tools' | 'done' | 'error';

export interface AgentConfig {
  id: string;
  name: string;
  alias?: string;            // short alias for @mention routing
  provider: ProviderType;
  model: string;
  persona: Persona;
  tools: string[];          // tool names this agent can use
  isBuiltin?: boolean;      // built-in agents cannot be modified/deleted
  maxTokens?: number;
  temperature?: number;
  maxHistoryEntries?: number; // max session entries to include in LLM context (default 30)
}

export interface AgentState {
  config: AgentConfig;
  status: AgentStatus;
  session: SessionEntry[];
  createdAt: number;
  lastActiveAt: number;
  error?: string;
}

// ─── Persona ──────────────────────────────────────────────────

export interface Persona {
  name: string;
  description: string;
  prompt: string;           // system prompt
  temperature?: number;
  modelPreference?: string;
  tools?: string[];
  rules?: string[];
}

// ─── Session ──────────────────────────────────────────────────

export type SessionEntryType =
  | 'message'
  | 'tool_call'
  | 'tool_result'
  | 'system_event'
  | 'agent_event'
  | 'checkpoint';

export interface SessionEntry {
  t: number;                          // unix timestamp
  type: SessionEntryType;
  agentId: string;
  // message
  role?: MessageRole;
  content?: string | ContentBlock[];
  // tool
  toolCall?: ToolCall;
  toolResult?: ToolResult;
  // meta
  model?: string;
  tokensIn?: number;
  tokensOut?: number;
  // system
  event?: string;
  data?: unknown;
}

// ─── Bridge ───────────────────────────────────────────────────

export type BridgeMessageType = 'direct' | 'broadcast' | 'topic';

export interface BridgeMessage {
  from: string;                     // sender agent id
  to?: string;                      // recipient agent id (direct)
  topic?: string;                   // topic (topic mode)
  type: BridgeMessageType;
  content: string;
  meta?: {
    model?: string;
    tokensIn?: number;
    tokensOut?: number;
  };
  timestamp: number;
}

export interface BridgeRoute {
  from: string;                     // source agent id (or '*')
  to: string;                       // destination agent id (or '*')
  topic?: string;                   // optional topic filter
  transform?: string;               // optional transform pipeline
}

// ─── Events ───────────────────────────────────────────────────

export type SystemEventType =
  | 'agent:spawned'
  | 'agent:status_change'
  | 'agent:error'
  | 'agent:response'
  | 'tool:called'
  | 'tool:result'
  | 'session:save'
  | 'session:load'
  | 'user:input'
  | 'bridge:message'
  | 'config:change'
  | 'system:error';

export interface SystemEvent {
  type: SystemEventType;
  timestamp: number;
  agentId?: string;
  data: unknown;
}

// ─── Config ───────────────────────────────────────────────────

export interface WeaveConfig {
  defaultProvider: ProviderType;
  defaultModel: string;
  providers: Partial<Record<ProviderType, ProviderConfig>>;
  sessionDir: string;               // default: ~/.weave/sessions/
  sessionCompression: boolean;      // default: true
  personasDir: string;              // default: ~/.weave/personas/
  autoSaveInterval: number;         // seconds, default: 30
  shellConfirmRequired: boolean;    // default: true
  theme: 'light' | 'dark' | 'auto';
  locale?: string;                  // saved language preference
}

// ─── CLI ──────────────────────────────────────────────────────

export interface CLIOptions {
  config?: string;
  session?: string;
  agent?: string;
  model?: string;
  provider?: ProviderType;
  pipe?: boolean;
  verbose?: boolean;
  version?: boolean;
  help?: boolean;
}
