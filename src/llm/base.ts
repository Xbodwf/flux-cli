import type { StreamEvent, ToolDefinition, Message } from '../core/types.js';

/**
 * LLM Provider interface.
 *
 * Every LLM backend implements this interface, allowing Weave to
 * swap models transparently. The core primitive is `chat()` which
 * returns an async iterable of stream events.
 */
export abstract class LLMProvider {
  /** Provider name (e.g. 'anthropic', 'openai') */
  abstract readonly name: string;

  /** The model identifier currently in use */
  abstract model: string;

  /**
   * Send a chat request and stream the response.
   *
   * Yields StreamEvent items — text deltas, tool calls, results, and stop signals.
   * This allows the consumer to render incrementally and handle tools in real-time.
   */
  abstract chat(
    messages: Message[],
    options: ChatOptions,
  ): AsyncIterable<StreamEvent>;

  /**
   * List available models for this provider.
   */
  abstract listModels(): Promise<string[]>;

  /**
   * Count tokens in a text string.
   * Returns an estimate if the API doesn't provide exact counts.
   */
  abstract countTokens(text: string): Promise<number>;

  /**
   * Check if the provider is properly configured (has API key, etc.)
   */
  abstract isConfigured(): boolean;

  /**
   * Validate that the provider can make a successful API call.
   * Useful for startup health checks and `weave doctor`.
   */
  abstract healthCheck(): Promise<{ ok: boolean; error?: string }>;

  /**
   * Get token usage for the last request.
   */
  abstract getLastUsage(): { tokensIn: number; tokensOut: number } | null;
}

export interface ChatOptions {
  system?: string;
  tools?: ToolDefinition[];
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  onToken?: (token: string) => void;
}
