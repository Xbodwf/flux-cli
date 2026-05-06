import chalk from 'chalk';
import { terminalWidth } from './ansi.js';

/**
 * Streaming Markdown → ANSI renderer.
 *
 * Tokenizes markdown line-by-line and emits styled terminal output.
 * Designed for streaming: call `processLine()` as each line arrives.
 *
 * Handles:
 * - # headers (level 1-6)
 * - ``` code blocks (with optional language)
 * - `inline code`
 * - **bold** and *italic*
 * - - list items
 * - > blockquotes
 * - --- horizontal rules
 * - [text](url) links
 */

export type MarkdownToken =
  | { type: 'text'; content: string }
  | { type: 'bold'; content: string }
  | { type: 'italic'; content: string }
  | { type: 'code'; content: string }
  | { type: 'link'; text: string; url: string };

/**
 * Render a single line of markdown to ANSI-styled text.
 */
export function renderMarkdownLine(line: string): string {
  // Empty line
  if (!line.trim()) return '';

  // Headers
  const headerMatch = line.match(/^(#{1,6})\s+(.+)$/);
  if (headerMatch) {
    const level = headerMatch[1]!.length;
    const text = headerMatch[2]!;
    return renderHeader(text, level);
  }

  // Code block fences
  if (line.startsWith('```')) return '';

  // Horizontal rule
  if (/^[-*_]{3,}\s*$/.test(line)) {
    return chalk.dim('─'.repeat(Math.min(terminalWidth(), 60)));
  }

  // Blockquote
  if (line.startsWith('> ')) {
    return chalk.dim('│') + ' ' + renderInline(line.slice(2));
  }

  // List items
  const listMatch = line.match(/^(\s*)([-*+]\s|\d+\.\s)(.+)$/);
  if (listMatch) {
    const indent = listMatch[1] || '';
    const bullet = listMatch[2]!;
    const text = listMatch[3]!;
    return indent + chalk.dim(bullet) + renderInline(text);
  }

  // Table row: | cell | cell | ...
  if (line.startsWith('|') && line.endsWith('|') && line.includes('|', 1)) {
    // Separator row (|---|---|) — render dimmed
    if (/^\|[\s:-]+\|[\s:-]*\|/.test(line) || /^\|:?-+:?\|$/.test(line)) {
      return chalk.dim(line);
    }
    const cells = line.replace(/^\||\|$/g, '').split('|').map(c => c.trim()).filter(Boolean);
    if (cells.length > 0) {
      const rendered = cells.map(c => renderInline(c)).join(chalk.dim(' │ '));
      return chalk.dim('│ ') + rendered + chalk.dim(' │');
    }
  }

  // Regular paragraph with inline formatting
  return renderInline(line);
}

/**
 * Render a header with proper ANSI styling.
 */
function renderHeader(text: string, level: number): string {
  const width = Math.min(terminalWidth(), 72);
  switch (level) {
    case 1: return chalk.bold.hex('#569CD6')(`# ${text}`) + '\n' + chalk.dim('━'.repeat(Math.min(text.length + 2, width)));
    case 2: return chalk.bold.hex('#4EC9B0')(`## ${text}`);
    case 3: return chalk.bold.hex('#CE9178')(`### ${text}`);
    default: return chalk.bold.dim(`${'#'.repeat(level)} ${text}`);
  }
}

/**
 * Render inline markdown (bold, italic, code, links).
 */
function renderInline(text: string): string {
  let result = text;

  // Images: ![alt](url) → [image: alt]
  result = result.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt) => chalk.dim(`[image: ${alt}]`));

  // Links: [text](url) → text (dimmed url)
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, linkText, url) => {
    return chalk.underline(linkText) + chalk.dim(` (${url})`);
  });

  // Inline code: `code`
  result = result.replace(/`([^`]+)`/g, (_, code) => chalk.bgHex('#1E1E1E').hex('#CE9178')(`\`${code}\``));

  // Bold: **text** or __text__
  result = result.replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_, b1, b2) => chalk.bold(b1 || b2));

  // Italic: *text* or _text_ (but not inside words with underscore)
  result = result.replace(/\*([^*]+)\*/g, (_, i) => chalk.italic(i));

  return result;
}

/**
 * Render a code block with optional syntax highlighting.
 * Falls back to a styled block if no highlighter available.
 */
export function renderCodeBlock(code: string, language = ''): string {
  const lines = code.split('\n');
  const width = Math.min(terminalWidth(), 80);
  const result: string[] = [];

  // Header line
  const langTag = language ? chalk.dim(` ${language} `) : '';
  result.push(chalk.dim('┌' + '─'.repeat(width - 2) + '┐') + langTag);

  // Code lines
  for (const line of lines) {
    const display = line || ' ';
    if (display.length > width - 4) {
      result.push(chalk.bgHex('#1E1E20').hex('#D4D4D4')(' │ ' + display.slice(0, width - 4) + ' │ '));
    } else {
      const padding = ' '.repeat(Math.max(0, width - 4 - display.length));
      result.push(chalk.bgHex('#1E1E20').hex('#D4D4D4')(' │ ' + display + padding + ' │'));
    }
  }

  // Footer
  result.push(chalk.dim('└' + '─'.repeat(width - 2) + '┘'));

  return result.join('\n');
}

/**
 * Render a diff block (unified format).
 * Green for additions, red for deletions, dim for context.
 */
export function renderDiff(diffText: string): string {
  return diffText
    .split('\n')
    .map(line => {
      if (line.startsWith('+') && !line.startsWith('+++')) {
        return chalk.green(line);
      }
      if (line.startsWith('-') && !line.startsWith('---')) {
        return chalk.red(line);
      }
      if (line.startsWith('@@')) {
        return chalk.cyan(line);
      }
      return chalk.dim(line);
    })
    .join('\n');
}

/**
 * Render a tool call (dimmed, compact style).
 */
export function renderToolCall(name: string, args: unknown): string {
  const argsStr = typeof args === 'object' && args !== null
    ? Object.entries(args as Record<string, unknown>)
        .map(([k, v]) => `${k}=${typeof v === 'string' && v.length > 40 ? v.slice(0, 40) + '…' : String(v)}`)
        .join(', ')
    : '';
  return chalk.dim(`⚡ ${name}(${argsStr})`);
}

/**
 * Render a tool result with content display and optional truncation.
 * detail=false → first 6 lines + fold hint
 * detail=true  → full content
 */
export function renderToolResultWithContent(
  name: string,
  content: string,
  isError: boolean,
  detail: boolean,
): string {
  const lines = content.split('\n');
  const showLines = detail ? lines : lines.slice(0, 6);
  const truncated = !detail && lines.length > 6;
  const result: string[] = [];

  // Status line
  if (isError) {
    result.push(chalk.dim(`  └─ ${chalk.red('error')}`));
  } else {
    result.push(chalk.dim(`  └─ ${chalk.green('done')} (${content.length} bytes, ${lines.length} lines)`));
  }

  // Content lines
  for (const line of showLines) {
    const truncated_line = line.length > 200 ? line.slice(0, 200) + '…' : line;
    result.push(chalk.dim('    │ ') + truncated_line);
  }

  // Fold hint
  if (truncated) {
    const msg = detail ? '' : `    ... ${lines.length - 6} more lines (Ctrl+O to expand)`;
    if (msg) result.push(chalk.dim.italic(msg));
  }

  return result.join('\n');
}

/**
 * Render a tool result (brief summary).
 */
export function renderToolResult(name: string, isError: boolean): string {
  if (isError) {
    return chalk.dim(`  └─ ${chalk.red('error')}`);
  }
  return chalk.dim(`  └─ ${chalk.green('done')}`);
}

/**
 * Render an error message.
 */
export function renderError(msg: string): string {
  return chalk.bgRed.white(' ERROR ') + ' ' + chalk.red(msg);
}

/**
 * Render a system prompt/note.
 */
export function renderSystem(msg: string): string {
  return chalk.dim.italic(msg);
}
