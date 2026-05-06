import OpenAI from 'openai';
import { OpenAIProvider } from './openai.js';

/**
 * Ollama provider — wraps OpenAI-compatible provider with Ollama defaults.
 *
 * Ollama serves an OpenAI-compatible API at http://localhost:11434/v1
 * so we reuse the OpenAI provider with a different base URL.
 */
export class OllamaProvider extends OpenAIProvider {
  constructor(config: { apiKey?: string; baseUrl?: string; defaultModel: string }) {
    super({
      apiKey: config.apiKey || 'ollama', // Ollama doesn't need a real key
      baseUrl: config.baseUrl || 'http://localhost:11434/v1',
      defaultModel: config.defaultModel || 'qwen2.5',
    });
  }

  async listModels(): Promise<string[]> {
    try {
      const response = await fetch('http://localhost:11434/api/tags');
      const data = await response.json() as { models?: Array<{ name: string }> };
      return data.models?.map(m => m.name) || ['qwen2.5', 'deepseek-coder', 'llama3'];
    } catch {
      return ['qwen2.5', 'deepseek-coder', 'llama3'];
    }
  }

  async healthCheck(): Promise<{ ok: boolean; error?: string }> {
    try {
      const response = await fetch('http://localhost:11434/api/tags');
      if (response.ok) return { ok: true };
      return { ok: false, error: `Ollama returned ${response.status}` };
    } catch (err) {
      return { ok: false, error: `Cannot connect to Ollama at localhost:11434 — ${err instanceof Error ? err.message : String(err)}` };
    }
  }
}
