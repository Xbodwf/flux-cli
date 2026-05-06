import OpenAI from 'openai';
import { LLMProvider, ChatOptions } from './base.js';
import type { Message, StreamEvent, ToolDefinition } from '../core/types.js';

/**
 * OpenAI provider (also supports any OpenAI-compatible endpoint).
 */
export class OpenAIProvider extends LLMProvider {
  readonly name = 'openai';
  model: string;
  private client: OpenAI;
  private lastUsage: { tokensIn: number; tokensOut: number } | null = null;

  constructor(config: { apiKey?: string; baseUrl?: string; defaultModel: string }) {
    super();
    this.model = config.defaultModel || 'gpt-4o';
    this.client = new OpenAI({
      apiKey: config.apiKey || process.env.OPENAI_API_KEY || '',
      baseURL: config.baseUrl,
    });
  }

  async *chat(
    messages: Message[],
    options: ChatOptions,
  ): AsyncIterable<StreamEvent> {
    const openaiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [];

    // System message
    if (options.system) {
      openaiMessages.push({ role: 'system', content: options.system });
    }

    // Convert messages
    for (const m of messages) {
      if (m.role === 'system') {
        openaiMessages.push({ role: 'system', content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) });
      } else if (m.role === 'assistant') {
        openaiMessages.push({ role: 'assistant', content: typeof m.content === 'string' ? m.content : this.contentToString(m.content) });
      } else {
        openaiMessages.push({ role: 'user', content: typeof m.content === 'string' ? m.content : this.contentToString(m.content) });
      }
    }

    const stream = await this.client.chat.completions.create({
      model: this.model,
      messages: openaiMessages,
      max_tokens: options.maxTokens ?? 4096,
      temperature: options.temperature ?? 0.3,
      tools: options.tools?.length ? this.toOpenAITools(options.tools) : undefined,
      stream: true,
      stream_options: { include_usage: true },
    });

    // Accumulate streaming tool call arguments by index.
    // OpenAI streams tool calls across multiple chunks — each chunk
    // carries a partial `arguments` string that must be joined and
    // parsed only when complete.
    const toolCallBuffers = new Map<number, { id: string; name: string; argsBuffer: string }>();

    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta;

      if (delta?.content) {
        yield { type: 'text_delta', delta: delta.content };
      }

      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index;
          if (idx === undefined) continue;

          let buffer = toolCallBuffers.get(idx);
          if (!buffer) {
            buffer = { id: '', name: '', argsBuffer: '' };
            toolCallBuffers.set(idx, buffer);
          }

          if (tc.id) buffer.id = tc.id;
          if (tc.function?.name) buffer.name = tc.function.name;
          if (tc.function?.arguments) {
            buffer.argsBuffer += tc.function.arguments;
          }

          // Try to parse accumulated JSON — only emit when complete
          if (buffer.name && buffer.argsBuffer) {
            try {
              const args = JSON.parse(buffer.argsBuffer);
              yield {
                type: 'tool_call',
                toolCall: {
                  id: buffer.id || `call_${Date.now()}`,
                  name: buffer.name,
                  args,
                },
              };
              toolCallBuffers.delete(idx);
            } catch {
              // JSON still incomplete — keep buffering
            }
          }
        }
      }

      // Handle usage info
      if (chunk.usage) {
        this.lastUsage = {
          tokensIn: chunk.usage.prompt_tokens,
          tokensOut: chunk.usage.completion_tokens,
        };
      }
    }

    // Flush any buffered tool calls that completed after the last chunk
    for (const [, buffer] of toolCallBuffers) {
      if (buffer.name && buffer.argsBuffer) {
        try {
          const args = JSON.parse(buffer.argsBuffer);
          yield {
            type: 'tool_call',
            toolCall: {
              id: buffer.id || `call_${Date.now()}`,
              name: buffer.name,
              args,
            },
          };
        } catch {
          // Incomplete JSON at end of stream — silent ignore
        }
      }
    }

    yield { type: 'stop', stopReason: 'end_turn' };
  }

  async listModels(): Promise<string[]> {
    try {
      const models = await this.client.models.list();
      return models.data.map(m => m.id);
    } catch {
      return ['gpt-4o', 'gpt-4o-mini', 'o3-mini'];
    }
  }

  async countTokens(text: string): Promise<number> {
    // Rough estimate: ~4 chars per token
    return Math.ceil(text.length / 4);
  }

  isConfigured(): boolean {
    return !!(this.client.apiKey);
  }

  async healthCheck(): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.client.models.list();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  getLastUsage(): { tokensIn: number; tokensOut: number } | null {
    return this.lastUsage;
  }

  private toOpenAITools(tools: ToolDefinition[]): OpenAI.Chat.ChatCompletionTool[] {
    return tools.map(t => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema as Record<string, unknown>,
      },
    }));
  }

  private contentToString(content: unknown): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .map(c => {
          if (typeof c === 'string') return c;
          if ('text' in c) return c.text;
          return JSON.stringify(c);
        })
        .filter(Boolean)
        .join('\n');
    }
    return String(content);
  }
}
