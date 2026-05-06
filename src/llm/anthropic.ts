import Anthropic from '@anthropic-ai/sdk';
import { LLMProvider, ChatOptions } from './base.js';
import type { Message, StreamEvent, ToolDefinition } from '../core/types.js';

/**
 * Anthropic Claude provider.
 */
export class AnthropicProvider extends LLMProvider {
  readonly name = 'anthropic';
  model: string;
  private client: Anthropic;
  private lastUsage: { tokensIn: number; tokensOut: number } | null = null;

  constructor(config: { apiKey?: string; baseUrl?: string; defaultModel: string }) {
    super();
    this.model = config.defaultModel || 'claude-sonnet-4-20250505';
    this.client = new Anthropic({
      apiKey: config.apiKey || process.env.ANTHROPIC_API_KEY || '',
      baseURL: config.baseUrl,
    });
  }

  async *chat(
    messages: Message[],
    options: ChatOptions,
  ): AsyncIterable<StreamEvent> {
    const response = await this.client.messages.stream({
      model: this.model,
      max_tokens: options.maxTokens ?? 4096,
      system: options.system,
      temperature: options.temperature,
      messages: messages.map(m => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: typeof m.content === 'string'
          ? m.content
          : m.content.map(c => {
              if (c.type === 'text') return { type: 'text' as const, text: c.text };
              if (c.type === 'tool_use') return { type: 'tool_use' as const, id: c.id, name: c.name, input: c.input as Record<string, unknown> };
              if (c.type === 'tool_result') return { type: 'tool_result' as const, tool_use_id: c.toolUseId, content: c.content };
              return { type: 'text' as const, text: JSON.stringify(c) };
            }),
      })),
      tools: options.tools?.length ? this.toAnthropicTools(options.tools) : undefined,
    });

    const stream = response;

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        yield { type: 'text_delta', delta: event.delta.text };
      }

      if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
        yield {
          type: 'tool_call',
          toolCall: {
            id: event.content_block.id,
            name: event.content_block.name,
            args: event.content_block.input,
          },
        };
      }

      if (event.type === 'message_stop') {
        // Get usage from final message
        const finalMessage = await response.finalMessage();
        const usage = finalMessage.usage;
        this.lastUsage = {
          tokensIn: usage.input_tokens,
          tokensOut: usage.output_tokens,
        };
        yield { type: 'stop', stopReason: 'end_turn' };
      }
    }
  }

  async listModels(): Promise<string[]> {
    try {
      const models = await this.client.models.list();
      return models.data.map(m => m.id);
    } catch {
      return ['claude-sonnet-4-20250505', 'claude-3-5-sonnet-20241022', 'claude-3-5-haiku-20241022'];
    }
  }

  async countTokens(text: string): Promise<number> {
    try {
      const response = await this.client.messages.countTokens({
        model: this.model,
        messages: [{ role: 'user', content: text }],
      });
      return response.input_tokens;
    } catch {
      return Math.ceil(text.length / 4);
    }
  }

  isConfigured(): boolean {
    return !!(this.client.apiKey);
  }

  async healthCheck(): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.client.models.list({ limit: 1 });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  getLastUsage(): { tokensIn: number; tokensOut: number } | null {
    return this.lastUsage;
  }

  private toAnthropicTools(tools: ToolDefinition[]) {
    return tools.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Messages.Tool.InputSchema,
    }));
  }
}
