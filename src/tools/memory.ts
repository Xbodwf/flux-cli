import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { ToolDefinition, ToolResult } from '../core/types.js';

const MEMORY_DIR = join(homedir(), '.flux', 'memories');
const MEMORY_FILE = join(MEMORY_DIR, 'memories.jsonl');

interface MemoryEntry {
  key: string;
  content: string;
  timestamp: number;
}

function ensureDir(): void {
  if (!existsSync(MEMORY_DIR)) {
    mkdirSync(MEMORY_DIR, { recursive: true });
  }
}

function loadAll(): MemoryEntry[] {
  if (!existsSync(MEMORY_FILE)) return [];
  const content = readFileSync(MEMORY_FILE, 'utf-8');
  const entries: MemoryEntry[] = [];
  for (const line of content.split('\n').filter(Boolean)) {
    try {
      entries.push(JSON.parse(line) as MemoryEntry);
    } catch { /* skip malformed */ }
  }
  return entries;
}

/**
 * memory_save — save a key-value memory for future recall.
 */
const memorySaveTool: ToolDefinition = {
  name: 'memory_save',
  description: 'Save an important piece of information to memory for future recall. Use this when the user tells you something you should remember across conversations, like preferences, project context, or decisions.',
  inputSchema: {
    type: 'object',
    properties: {
      key: { type: 'string', description: 'A unique key for this memory (e.g. "user_preference_theme", "project_decision_auth")' },
      content: { type: 'string', description: 'The memory content to save' },
    },
    required: ['key', 'content'],
  },
  handler: async (args: unknown): Promise<ToolResult> => {
    const { key, content } = args as { key: string; content: string };
    try {
      ensureDir();
      const entry: MemoryEntry = { key, content, timestamp: Date.now() };
      writeFileSync(MEMORY_FILE, JSON.stringify(entry) + '\n', { flag: 'a' });
      return { content: [{ type: 'text', data: `Memory saved: "${key}"` }] };
    } catch (err) {
      return {
        content: [{ type: 'error', data: err instanceof Error ? err.message : String(err) }],
        isError: true,
      };
    }
  },
};

/**
 * memory_search — search saved memories by keyword.
 */
const memorySearchTool: ToolDefinition = {
  name: 'memory_search',
  description: 'Search saved memories by keyword. Call this when you need to recall information the user told you earlier — preferences, project decisions, or any saved context.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Keyword to search for in memory keys and content' },
    },
    required: ['query'],
  },
  handler: async (args: unknown): Promise<ToolResult> => {
    const { query } = args as { query: string };
    try {
      const all = loadAll();
      const queryLower = query.toLowerCase();
      const results = all.filter(
        m => m.key.toLowerCase().includes(queryLower) || m.content.toLowerCase().includes(queryLower),
      ).sort((a, b) => b.timestamp - a.timestamp).slice(0, 20);

      if (results.length === 0) {
        return { content: [{ type: 'text', data: 'No memories found for: ' + query }] };
      }

      const output = results.map(m =>
        `[${m.key}] (${new Date(m.timestamp).toLocaleString()})\n${m.content}`
      ).join('\n\n---\n\n');

      return { content: [{ type: 'text', data: output }], meta: { count: results.length } };
    } catch (err) {
      return {
        content: [{ type: 'error', data: err instanceof Error ? err.message : String(err) }],
        isError: true,
      };
    }
  },
};

/**
 * memory_list — list all saved memory keys.
 */
const memoryListTool: ToolDefinition = {
  name: 'memory_list',
  description: 'List all saved memory keys. Useful for discovering what has been remembered before searching for specific content.',
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
  handler: async (): Promise<ToolResult> => {
    try {
      const all = loadAll();
      if (all.length === 0) {
        return { content: [{ type: 'text', data: 'No memories saved yet.' }] };
      }
      const output = all.map(m =>
        `  ${m.key.padEnd(30)} ${new Date(m.timestamp).toLocaleString()}`
      ).join('\n');
      return { content: [{ type: 'text', data: `Saved memories (${all.length}):\n${output}` }] };
    } catch (err) {
      return {
        content: [{ type: 'error', data: err instanceof Error ? err.message : String(err) }],
        isError: true,
      };
    }
  },
};

export const memoryTools: ToolDefinition[] = [
  memorySaveTool,
  memorySearchTool,
  memoryListTool,
];
