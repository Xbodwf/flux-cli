import type { ProviderType } from '../core/types.js';
import { LLMProvider, type ChatOptions } from './base.js';
export { LLMProvider, type ChatOptions };

import { AnthropicProvider } from './anthropic.js';
import { OpenAIProvider } from './openai.js';
import { GoogleProvider } from './google.js';
import { OllamaProvider } from './ollama.js';

/**
 * Provider factory — creates the right provider based on type + config.
 */
export function createProvider(
  type: string,
  config: {
    apiKey?: string;
    baseUrl?: string;
    defaultModel: string;
  },
): LLMProvider {
  switch (type) {
    case 'anthropic':
      return new AnthropicProvider(config);
    case 'openai':
    case 'openai-compatible':
      return new OpenAIProvider({ ...config, baseUrl: config.baseUrl });
    case 'google':
      return new GoogleProvider(config);
    case 'ollama':
      return new OllamaProvider(config);
    default:
      throw new Error(`Unknown provider type: ${type}`);
  }
}
