import { readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { homedir, platform } from 'node:os';
import { execSync } from 'node:child_process';
import { ToolRegistry } from './registry.js';
import { memoryTools } from './memory.js';
import { authorizer } from '../core/auth.js';
import { getCurrentAgentName } from '../core/exec-context.js';
import type { ToolDefinition, ToolResult } from '../core/types.js';

// ─── Auth Helpers ─────────────────────────────────────────

/**
 * Wrap a file read with authorization. Returns the result or a permission-denied error.
 */
async function withReadAuth(path: string, fn: () => Promise<ToolResult>): Promise<ToolResult> {
  const agentName = getCurrentAgentName() || 'agent';
  const decision = await authorizer.checkRead(agentName, path);
  if (decision === 'deny') {
    return {
      content: [{ type: 'error', data: `Permission denied: ${agentName} cannot read ${path}` }],
      isError: true,
    };
  }
  return fn();
}

/**
 * Wrap a file write with authorization.
 */
async function withWriteAuth(path: string, fn: () => Promise<ToolResult>): Promise<ToolResult> {
  const agentName = getCurrentAgentName() || 'agent';
  const decision = await authorizer.checkWrite(agentName, path);
  if (decision === 'deny') {
    return {
      content: [{ type: 'error', data: `Permission denied: ${agentName} cannot write to ${path}` }],
      isError: true,
    };
  }
  return fn();
}

// ─── Register All Tools ───────────────────────────────────

/**
 * Register all built-in tools.
 */
export function registerBuiltinTools(registry: ToolRegistry): void {
  registry.registerMany([
    readFileTool,
    writeFileTool,
    editFileTool,
    globFilesTool,
    grepSearchTool,
    listDirTool,
    readFilesTool,
    shellTool,
    ...memoryTools,
  ]);
}

// ─── Tool Definitions ─────────────────────────────────────

const readFileTool: ToolDefinition = {
  name: 'read_file',
  description: 'Read the contents of a file. Provide the absolute path.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute path to the file' },
      limit: { type: 'number', description: 'Max lines to read' },
      offset: { type: 'number', description: 'Starting line number' },
    },
    required: ['path'],
  },
  handler: async (args: unknown): Promise<ToolResult> => {
    const { path, limit, offset } = args as { path: string; limit?: number; offset?: number };
    return withReadAuth(path, async () => {
      try {
        const content = await readFile(path, 'utf-8');
        const lines = content.split('\n');
        const start = offset ?? 0;
        const end = limit ? start + limit : lines.length;
        const snippet = lines.slice(start, end).join('\n');
        return {
          content: [{ type: 'text', data: snippet }],
          meta: { totalLines: lines.length, start, end },
        };
      } catch (err) {
        return {
          content: [{ type: 'error', data: err instanceof Error ? err.message : String(err) }],
          isError: true,
        };
      }
    });
  },
};

const writeFileTool: ToolDefinition = {
  name: 'write_file',
  description: 'Write content to a file (overwrites existing). Use absolute paths.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute path to the file' },
      content: { type: 'string', description: 'Content to write' },
    },
    required: ['path', 'content'],
  },
  handler: async (args: unknown): Promise<ToolResult> => {
    const { path, content } = args as { path: string; content: string };
    return withWriteAuth(path, async () => {
      try {
        await writeFile(path, content, 'utf-8');
        const lines = content.split('\n').length;
        return { content: [{ type: 'text', data: `Written ${lines} lines to ${path}` }] };
      } catch (err) {
        return {
          content: [{ type: 'error', data: err instanceof Error ? err.message : String(err) }],
          isError: true,
        };
      }
    });
  },
};

const globFilesTool: ToolDefinition = {
  name: 'glob',
  description: 'Find files matching a glob pattern. Use ** for recursive search.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern (e.g. "src/**/*.ts")' },
      path: { type: 'string', description: 'Directory to search in (default: cwd)' },
    },
    required: ['pattern'],
  },
  handler: async (args: unknown): Promise<ToolResult> => {
    const { pattern, path: searchPath } = args as { pattern: string; path?: string };
    try {
      const results = await findFiles(searchPath || process.cwd(), pattern);
      return {
        content: [{ type: 'text', data: results.join('\n') }],
        meta: { count: results.length },
      };
    } catch (err) {
      return {
        content: [{ type: 'error', data: err instanceof Error ? err.message : String(err) }],
        isError: true,
      };
    }
  },
};

const grepSearchTool: ToolDefinition = {
  name: 'grep',
  description: 'Search for a pattern in files. Supports regex.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Search pattern (regex)' },
      path: { type: 'string', description: 'Directory or file to search' },
      glob: { type: 'string', description: 'File glob filter (e.g. "*.ts")' },
    },
    required: ['pattern'],
  },
  handler: async (args: unknown): Promise<ToolResult> => {
    const { pattern, path: searchPath, glob } = args as { pattern: string; path?: string; glob?: string };
    try {
      let cmd = `rg --no-heading --line-number '${pattern.replace(/'/g, "'\\''")}'`;
      if (searchPath) cmd += ` ${searchPath}`;
      if (glob) cmd += ` --glob '${glob}'`;

      try {
        const output = execSync(cmd, { encoding: 'utf-8', maxBuffer: 1024 * 1024 });
        return { content: [{ type: 'text', data: output || '(no matches)' }] };
      } catch {
        return { content: [{ type: 'text', data: '(no matches)' }] };
      }
    } catch (err) {
      return {
        content: [{ type: 'error', data: err instanceof Error ? err.message : String(err) }],
        isError: true,
      };
    }
  },
};

const listDirTool: ToolDefinition = {
  name: 'list_dir',
  description: 'List files and directories in a path.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory path' },
    },
    required: ['path'],
  },
  handler: async (args: unknown): Promise<ToolResult> => {
    const { path } = args as { path: string };
    try {
      const entries = await readdir(path, { withFileTypes: true });
      const listing = entries.map(e => {
        const type = e.isDirectory() ? 'dir' : e.isFile() ? 'file' : 'other';
        return `${type}\t${e.name}`;
      });
      return { content: [{ type: 'text', data: listing.join('\n') }], meta: { count: entries.length } };
    } catch (err) {
      return {
        content: [{ type: 'error', data: err instanceof Error ? err.message : String(err) }],
        isError: true,
      };
    }
  },
};

const readFilesTool: ToolDefinition = {
  name: 'read_files',
  description: 'Read multiple files at once. Provide an array of absolute paths.',
  inputSchema: {
    type: 'object',
    properties: {
      paths: {
        type: 'array',
        items: { type: 'string' },
        description: 'Array of absolute file paths',
      },
    },
    required: ['paths'],
  },
  handler: async (args: unknown): Promise<ToolResult> => {
    const { paths } = args as { paths: string[] };
    const results: string[] = [];
    for (const p of paths) {
      const agentName = getCurrentAgentName() || 'agent';
      const decision = await authorizer.checkRead(agentName, p);
      if (decision === 'deny') {
        results.push(`=== ${p} ===\n[Permission denied]`);
        continue;
      }
      try {
        const content = await readFile(p, 'utf-8');
        results.push(`=== ${p} ===\n${content}`);
      } catch (err) {
        results.push(`=== ${p} ===\n[ERROR: ${err instanceof Error ? err.message : String(err)}]`);
      }
    }
    return { content: [{ type: 'text', data: results.join('\n\n') }] };
  },
};

// ─── Shell Tool ───────────────────────────────────────────

/**
 * Default shell per platform.
 */
function getDefaultShell(): string {
  if (platform() === 'win32') return 'pwsh';
  return 'bash';
}

const shellTool: ToolDefinition = {
  name: 'shell',
  description: 'Execute a shell command on the local system. Requires user authorization.',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command to execute' },
      shell: { type: 'string', description: `Shell to use (default: ${getDefaultShell()})` },
    },
    required: ['command'],
  },
  handler: async (args: unknown): Promise<ToolResult> => {
    const { command, shell } = args as { command: string; shell?: string };
    const agentName = getCurrentAgentName() || 'agent';

    const decision = await authorizer.checkShell(agentName, command);
    if (decision === 'deny') {
      return {
        content: [{ type: 'error', data: `Permission denied: shell command blocked` }],
        isError: true,
      };
    }

    try {
      const output = execSync(command, {
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
        shell: shell || getDefaultShell(),
      });
      return {
        content: [{ type: 'text', data: output || '(no output)' }],
        meta: { exitCode: 0 },
      };
    } catch (err: unknown) {
      const execErr = err as { status?: number; stdout?: string; stderr?: string; message?: string };
      return {
        content: [{
          type: 'text',
          data: execErr.stdout || '' + '\n' + (execErr.stderr || execErr.message || String(err)),
        }],
        isError: true,
        meta: { exitCode: execErr.status ?? 1 },
      };
    }
  },
};

// ─── Helper: edit file ────────────────────────────────────

const editFileTool: ToolDefinition = {
  name: 'edit_file',
  description: 'Edit a file by finding and replacing text. Use old_string to uniquely identify the section and new_string as the replacement. Reports lines added/removed.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute path to the file' },
      old_string: { type: 'string', description: 'The exact text to replace (must match file content exactly)' },
      new_string: { type: 'string', description: 'The replacement text' },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  handler: async (args: unknown): Promise<ToolResult> => {
    const { path, old_string, new_string } = args as { path: string; old_string: string; new_string: string };
    return withWriteAuth(path, async () => {
      try {
        const content = await readFile(path, 'utf-8');
        if (!content.includes(old_string)) {
          return {
            content: [{ type: 'error', data: `old_string not found in ${path}. The text must match exactly.` }],
            isError: true,
          };
        }
        const newContent = content.replace(old_string, new_string);
        await writeFile(path, newContent, 'utf-8');
        const removedLines = old_string.split('\n').length;
        const addedLines = new_string.split('\n').length;
        const diffLines = addedLines - removedLines;
        const diffStr = diffLines >= 0 ? `+${diffLines}` : `${diffLines}`;
        return {
          content: [{
            type: 'text',
            data: `Edited ${path}: removed ${removedLines} lines, added ${addedLines} lines (${diffStr} lines)`,
          }],
        };
      } catch (err) {
        return {
          content: [{ type: 'error', data: err instanceof Error ? err.message : String(err) }],
          isError: true,
        };
      }
    });
  },
};

// ─── Helper: basic recursive file matching ────────────────────

async function findFiles(dir: string, pattern: string): Promise<string[]> {
  const results: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = resolve(dir, entry.name);
    if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
      if (pattern.includes('**')) {
        results.push(...await findFiles(fullPath, pattern));
      }
    } else if (entry.isFile()) {
      const rel = relative(process.cwd(), fullPath);
      if (matchGlob(rel, pattern)) {
        results.push(fullPath);
      }
    }
  }

  return results;
}

function matchGlob(path: string, pattern: string): boolean {
  const regexStr = pattern
    .replace(/\*\*/g, '___DOUBLESTAR___')
    .replace(/\*/g, '[^/]*')
    .replace(/___DOUBLESTAR___/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${regexStr}$`).test(path);
}
