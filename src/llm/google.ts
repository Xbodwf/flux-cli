import { GoogleGenerativeAI } from '@google/generative-ai';
import { LLMProvider, ChatOptions } from './base.js';
import type { Message, StreamEvent, ToolDefinition } from '../core/types.js';

/**
 * Google Gemini provider.
 */
export class GoogleProvider extends LLMProvider {
  readonly name = 'google';
  model: string;
  private client: GoogleGenerativeAI;
  private lastUsage: { tokensIn: number; tokensOut: number } | null = null;

  constructor(config: { apiKey?: string; baseUrl?: string; defaultModel: string }) {
    super();
    this.model = config.defaultModel || 'gemini-2.5-pro';
    this.client = new GoogleGenerativeAI(
      config.apiKey || process.env.GEMINI_API_KEY || '',
    );
  }

  async *chat(
    messages: Message[],
    options: ChatOptions,
  ): AsyncIterable<StreamEvent> {
    const genModel = this.client.getGenerativeModel({
      model: this.model,
      systemInstruction: options.system,
    });

    const chat = genModel.startChat({
      history: messages.slice(0, -1).map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }],
      })),
      tools: options.tools?.length ? this.toGoogleTools(options.tools) as any : undefined,
    });

    const lastMsg = messages[messages.length - 1];
    const prompt = typeof lastMsg?.content === 'string' ? lastMsg.content : JSON.stringify(lastMsg?.content);

    const result = await chat.sendMessageStream(prompt);

    for await (const chunk of result.stream) {
      const text = chunk.text();
      if (text) {
        yield { type: 'text_delta', delta: text };
      }

      // Check for function calls
      const fc = chunk.functionCall?.();
      if (fc) {
        yield {
          type: 'tool_call',
          toolCall: {
            id: `fc_${Date.now()}`,
            name: fc.name,
            args: fc.args as Record<string, unknown>,
          },
        };
      }
    }

    // Get usage from response
    const response = await result.response;
    const usage = response.usageMetadata;
    if (usage) {
      this.lastUsage = {
        tokensIn: usage.promptTokenCount,
        tokensOut: usage.candidatesTokenCount,
      };
    }

    yield { type: 'stop', stopReason: 'end_turn' };
  }

  async listModels(): Promise<string[]> {
    return ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash'];
  }

  async countTokens(text: string): Promise<number> {
    try {
      const model = this.client.getGenerativeModel({ model: this.model });
      const result = await model.countTokens(text);
      return result.totalTokens;
    } catch {
      return Math.ceil(text.length / 4);
    }
  }

  isConfigured(): boolean {
    return !!(process.env.GEMINI_API_KEY || this.client.apiKey);
  }

  async healthCheck(): Promise<{ ok: boolean; error?: string }> {
    try {
      const model = this.client.getGenerativeModel({ model: this.model });
      await model.countTokens('test');
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  getLastUsage(): { tokensIn: number; tokensOut: number } | null {
    return this.lastUsage;
  }

  private toGoogleTools(tools: ToolDefinition[]) {
    return [{
      functionDeclarations: tools.map(t => ({
        name: t.name,
        description: t.description,
        parameters: t.inputSchema as Record<string, unknown>,
      })),
    }];
  }
}
