import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getLocale } from '../i18n/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPT_DIR = join(__dirname, '..', 'static', 'prompts');

/**
 * Language name mapping for agent prompt injection.
 */
const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',
  zh: 'Chinese',
};

/**
 * Shared prompt files loaded for all agents.
 * These define the agent's identity, strategy, security rules, and behavioral rules.
 */
const SHARED_PROMPTS = ['identity.md', 'strategy.md', 'security.md', 'rules.md'];

/**
 * Read a single prompt file. Returns the content or empty string.
 */
function readPromptFile(filename: string): string {
  const path = join(PROMPT_DIR, filename);
  if (existsSync(path)) {
    return readFileSync(path, 'utf-8').trim();
  }
  return '';
}

/**
 * Build a language instruction to inject into the system prompt.
 * This prevents AI from mixing languages in its responses.
 */
function buildLanguageInstruction(): string {
  const locale = getLocale();
  const langName = LANGUAGE_NAMES[locale] || 'English';
  return `## Language\n\nThe user's language is set to: ${langName}. Always respond in ${langName}. Never mix languages in your response.`;
}

/**
 * Build a complete system prompt by combining shared prompts
 * with an optional agent-specific prompt and language instruction.
 *
 * Shared prompts (identity, strategy, security, rules) are loaded from
 * src/static/prompts/ and are prepended before the agent-specific prompt.
 *
 * @param agentPrompt - Optional agent-specific prompt from the persona YAML
 * @returns Combined system prompt string
 */
export function buildSystemPrompt(agentPrompt?: string): string {
  const parts: string[] = [];

  // Shared prompts
  for (const file of SHARED_PROMPTS) {
    const content = readPromptFile(file);
    if (content) {
      parts.push(content);
    }
  }

  // Agent-specific prompt from persona YAML
  if (agentPrompt) {
    parts.push(agentPrompt);
  }

  // Language instruction — prevents mixed-language responses
  parts.push(buildLanguageInstruction());

  if (parts.length === 0) {
    return 'You are a helpful AI assistant. You can use tools to read and write files, search code, and execute commands.';
  }

  return parts.join('\n\n');
}

/**
 * Load the scanner agent's system prompt from scanner.md.
 * The scanner is a special built-in agent without a persona YAML.
 */
export function loadScannerPrompt(): string {
  const content = readPromptFile('scanner.md');
  if (content) {
    return content;
  }
  // Minimal fallback
  return `You are a task routing agent. Analyze user requests and delegate them to the appropriate specialist agents using @mentions.`;
}
