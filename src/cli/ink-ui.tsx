import React from 'react';
import { render, Text, Box, Static, useInput } from 'ink';
import type { Instance } from 'ink';
import { terminalWidth } from './ansi.js';

// ─── Types ───────────────────────────────────────────────────────────

export interface StatusBarInfo {
  model: string;
  tokensIn?: number;
  tokensOut?: number;
  agentName?: string;
}

export type OutputLineType =
  | 'text' | 'empty' | 'header' | 'list' | 'blockquote' | 'separator' | 'table'
  | 'system' | 'tool_call' | 'tool_result' | 'error' | 'code_block';

export interface OutputLine {
  id: number;
  type: OutputLineType;
  content: string;       // raw markdown line content
  meta?: Record<string, unknown>;
}

interface InkUIState {
  lines: OutputLine[];
  status: StatusBarInfo | null;
  spinner: string | null;
  input: string;
  processing: boolean;
  detailMode: boolean;
  nextId: number;
}

interface InkUICallbacks {
  onSubmit: (input: string) => void;
  onAbort: () => void;
  onInterrupt: () => void;
  onInputChange: (input: string) => void;
  onToggleDetail: () => void;
}

// ─── Inline Markdown → Ink Components ────────────────────────────────

type InlineToken =
  | { type: 'text'; value: string }
  | { type: 'bold'; value: string }
  | { type: 'italic'; value: string }
  | { type: 'code'; value: string }
  | { type: 'link'; text: string; url: string };

function tokenizeInline(text: string): InlineToken[] {
  if (!text) return [{ type: 'text', value: '' }];
  const tokens: InlineToken[] = [];
  const regex = /(\[([^\]]+)\]\(([^)]+)\))|(`([^`]+)`)|(\*\*([^*]+)\*\*)|(__([^_]+)__)|(\*([^*]+)\*)|_([^_]+)_/;
  let remaining = text;

  while (remaining.length > 0) {
    const match = regex.exec(remaining);
    if (!match) {
      tokens.push({ type: 'text', value: remaining });
      break;
    }

    // Text before match
    if (match.index > 0) {
      tokens.push({ type: 'text', value: remaining.slice(0, match.index) });
    }

    if (match[1]) {
      // link: [text](url)
      tokens.push({ type: 'link', text: match[2]!, url: match[3]! });
    } else if (match[4]) {
      // inline code
      tokens.push({ type: 'code', value: match[5]! });
    } else if (match[6]) {
      tokens.push({ type: 'bold', value: match[7]! });
    } else if (match[8]) {
      tokens.push({ type: 'bold', value: match[9]! });
    } else if (match[10]) {
      tokens.push({ type: 'italic', value: match[11]! });
    } else if (match[12]) {
      tokens.push({ type: 'italic', value: match[13]! });
    }

    remaining = remaining.slice(match.index + match[0].length);
  }

  return tokens;
}

function MarkdownText({ text }: { text: string }): React.JSX.Element {
  const tokens = tokenizeInline(text);
  return (
    <Text>
      {tokens.map((token, i) => {
        switch (token.type) {
          case 'bold':
            return <Text key={i} bold>{token.value}</Text>;
          case 'italic':
            return <Text key={i} italic>{token.value}</Text>;
          case 'code':
            return <Text key={i} color="#CE9178">{`\`${token.value}\``}</Text>;
          case 'link':
            return (
              <Text key={i}>
                <Text underline>{token.text}</Text>
                <Text dimColor> ({token.url})</Text>
              </Text>
            );
          default:
            return <Text key={i}>{token.value}</Text>;
        }
      })}
    </Text>
  );
}

// ─── Output Line Components ──────────────────────────────────────────

function HeaderLine({ text }: { text: string }): React.JSX.Element {
  const match = text.match(/^(#{1,6})\s+(.+)$/);
  if (!match) return <MarkdownText text={text} />;
  const level = match[1]!.length;
  const content = match[2]!;
  switch (level) {
    case 1:
      return (
        <Box flexDirection="column">
          <Text bold color="#569CD6"># {content}</Text>
          <Text dimColor>{'━'.repeat(Math.min(content.length + 2, terminalWidth()))}</Text>
        </Box>
      );
    case 2:
      return <Text bold color="#4EC9B0">## {content}</Text>;
    case 3:
      return <Text bold color="#CE9178">### {content}</Text>;
    default:
      return <Text bold dimColor>{'#'.repeat(level)} {content}</Text>;
  }
}

function ListLine({ text }: { text: string }): React.JSX.Element {
  const match = text.match(/^(\s*)([-*+]\s|\d+\.\s)(.+)$/);
  if (!match) return <MarkdownText text={text} />;
  const indent = match[1] || '';
  const bullet = match[2]!;
  const content = match[3]!;
  return (
    <Text>
      <Text dimColor>{indent}{bullet}</Text>
      <MarkdownText text={content} />
    </Text>
  );
}

function BlockquoteLine({ text }: { text: string }): React.JSX.Element {
  const content = text.startsWith('> ') ? text.slice(2) : text;
  return (
    <Box>
      <Text dimColor>│ </Text>
      <MarkdownText text={content} />
    </Box>
  );
}

function SeparatorLine(): React.JSX.Element {
  return <Text dimColor>{'─'.repeat(Math.min(terminalWidth(), 60))}</Text>;
}

function TableLine({ text }: { text: string }): React.JSX.Element {
  // Separator row (|---|---|)
  if (/^\|[\s:-]+\|[\s:-]*\|/.test(text) || /^\|:?-+:?\|$/.test(text)) {
    return <Text dimColor>{text}</Text>;
  }

  const cells = text.replace(/^\||\|$/g, '').split('|').map(c => c.trim()).filter(Boolean);
  if (cells.length === 0) return <MarkdownText text={text} />;

  const rendered = cells.map((c, i) => <MarkdownText key={i} text={c} />);
  return (
    <Box>
      <Text dimColor>│ </Text>
      {rendered.map((r, i) => (
        <Box key={i}>
          {r}
          {i < rendered.length - 1 && <Text dimColor> │ </Text>}
        </Box>
      ))}
      <Text dimColor> │</Text>
    </Box>
  );
}

function CodeBlockView({ code, language }: { code: string; language: string }): React.JSX.Element {
  const width = Math.min(terminalWidth(), 80);
  const lines = code.split('\n');
  return (
    <Box flexDirection="column">
      <Box>
        <Text dimColor>{'┌' + '─'.repeat(width - 2) + '┐'}</Text>
        {language && <Text dimColor> {language}</Text>}
      </Box>
      {lines.map((line, i) => (
        <Box key={i} backgroundColor="#1E1E20">
          <Text color="#D4D4D4">
            {' │ ' + (line || ' ') + ' '.repeat(Math.max(0, width - 4 - (line || ' ').length)) + ' │'}
          </Text>
        </Box>
      ))}
      <Text dimColor>{'└' + '─'.repeat(width - 2) + '┘'}</Text>
    </Box>
  );
}

function ToolCallLine({ name, args }: { name: string; args: unknown }): React.JSX.Element {
  const argsStr = typeof args === 'object' && args !== null
    ? Object.entries(args as Record<string, unknown>)
        .map(([k, v]) => `${k}=${typeof v === 'string' && v.length > 40 ? v.slice(0, 40) + '…' : String(v)}`)
        .join(', ')
    : '';
  return <Text dimColor>⚡ {name}({argsStr})</Text>;
}

function ToolResultLine({ name, content, isError, detail }: {
  name: string; content: string; isError: boolean; detail: boolean;
}): React.JSX.Element {
  const lines = content.split('\n');
  const showLines = detail ? lines : lines.slice(0, 6);
  const truncated = !detail && lines.length > 6;
  const result: React.JSX.Element[] = [];

  // Status line
  result.push(
    <Text key="status" dimColor>
      {'  └─ '}{isError
        ? <Text color="red">error</Text>
        : <Text color="green">done</Text>
      } ({content.length} bytes, {lines.length} lines)
    </Text>
  );

  // Content lines
  for (let i = 0; i < showLines.length; i++) {
    const line = showLines[i]!;
    const display = line.length > 200 ? line.slice(0, 200) + '…' : line;
    result.push(
      <Text key={`line-${i}`} dimColor>{'    │ '}{display}</Text>
    );
  }

  // Fold hint
  if (truncated) {
    result.push(
      <Text key="hint" dimColor italic>
        {'    ... '}{lines.length - 6} more lines (Ctrl+O to expand)
      </Text>
    );
  }

  return <Box flexDirection="column">{result}</Box>;
}

function ErrorLine({ msg }: { msg: string }): React.JSX.Element {
  return (
    <Box>
      <Text backgroundColor="red" color="white"> ERROR </Text>
      <Text color="red"> {msg}</Text>
    </Box>
  );
}

// ─── Output Line Dispatcher ──────────────────────────────────────────

export function OutputLineComponent({ line, detailMode }: {
  line: OutputLine; detailMode: boolean;
}): React.JSX.Element | null {
  switch (line.type) {
    case 'empty':
      return <Text> </Text>;
    case 'header':
      return <HeaderLine text={line.content} />;
    case 'list':
      return <ListLine text={line.content} />;
    case 'blockquote':
      return <BlockquoteLine text={line.content} />;
    case 'separator':
      return <SeparatorLine />;
    case 'table':
      return <TableLine text={line.content} />;
    case 'system':
      return <Text dimColor italic>── {line.content}</Text>;
    case 'tool_call':
      return <ToolCallLine name={line.content} args={line.meta?.args} />;
    case 'tool_result':
      return (
        <ToolResultLine
          name={line.content}
          content={(line.meta?.fullContent as string) || ''}
          isError={!!line.meta?.isError}
          detail={detailMode}
        />
      );
    case 'error': {
      // Check if it's a rendered error or raw message
      if (line.content.startsWith(' ERROR ')) {
        return <ErrorLine msg={line.content} />;
      }
      return (
        <Box>
          <Text backgroundColor="red" color="white"> ERROR </Text>
          <Text color="red"> {line.content}</Text>
        </Box>
      );
    }
    default:
      return <MarkdownText text={line.content} />;
  }
}

// ─── Code Block State Machine ────────────────────────────────────────

const enum CbState { OUT, IN, PENDING_PARTIAL }

// ─── InkApp Component ────────────────────────────────────────────────

interface InkAppProps {
  state: InkUIState;
  callbacks: InkUICallbacks;
}

function InkApp({ state, callbacks }: InkAppProps): React.JSX.Element {
  useInput((input, key) => {
    // Ctrl+C — interrupt/exit
    if (key.ctrl && (input === 'c' || input === 'C')) {
      callbacks.onInterrupt();
      return;
    }

    // Ctrl+O — toggle detail mode
    if (key.ctrl && (input === 'o' || input === 'O')) {
      callbacks.onToggleDetail();
      return;
    }

    if (state.processing) {
      // During processing, only Esc is allowed
      if (key.escape) {
        callbacks.onAbort();
      }
      return;
    }

    // Idle state — handle input
    if (key.return) {
      const currentInput = state.input;
      callbacks.onSubmit(currentInput);
      return;
    }

    if (key.backspace || key.delete) {
      if (state.input.length > 0) {
        callbacks.onInputChange(state.input.slice(0, -1));
      }
      return;
    }

    if (input && input.length === 1) {
      callbacks.onInputChange(state.input + input);
    }
  });

  return (
    <Box flexDirection="column">
      {/* Persistent output history */}
      <Static items={state.lines}>
        {(line: OutputLine) => (
          <OutputLineComponent key={line.id} line={line} detailMode={state.detailMode} />
        )}
      </Static>

      {/* Spinner during processing */}
      {state.processing && state.spinner && (
        <Text dimColor>{state.spinner}</Text>
      )}

      {/* Input prompt when idle */}
      {!state.processing && (
        <Box>
          <Text bold color="#569CD6">❯ </Text>
          <Text>{state.input}</Text>
        </Box>
      )}

      {/* Status bar */}
      {state.status && (
        <StatusBarComponent status={state.status} />
      )}
    </Box>
  );
}

export function StatusBarComponent({ status }: { status: StatusBarInfo }): React.JSX.Element {
  const tokens = (status.tokensIn || status.tokensOut)
    ? `in:${status.tokensIn || '?'} out:${status.tokensOut || '?'}`
    : '';
  const agent = status.agentName ? ` [${status.agentName}]` : '';
  const left = `${status.model}${agent}`;

  return (
    <Box>
      <Text dimColor>{left}</Text>
      {tokens && (
        <Box marginLeft={1}>
          <Text dimColor>{tokens}</Text>
        </Box>
      )}
    </Box>
  );
}

// ─── InkUI Class (public API, FluxUI-compatible) ─────────────────────

export class InkUI {
  private inkInstance: Instance;
  private state: InkUIState;
  private callbacks: InkUICallbacks = {
    onSubmit: () => {},
    onAbort: () => {},
    onInterrupt: () => {},
    onInputChange: () => {},
    onToggleDetail: () => {},
  };

  // Code block state machine
  private inCodeBlock = false;
  private codeBlockLanguage = '';
  private codeBlockLines: string[] = [];
  private pendingPartial = '';

  // Tool result tracking
  private currentToolName = '';
  private lastToolResult: { name: string; content: string; isError: boolean } | null = null;

  // Called when user submits input
  onInput: ((input: string) => void) | null = null;
  onAbort: (() => void) | null = null;
  onInterrupt: (() => void) | null = null;

  constructor() {
    this.state = {
      lines: [],
      status: null,
      spinner: null,
      input: '',
      processing: false,
      detailMode: false,
      nextId: 0,
    };

    this.setupCallbacks();

    this.inkInstance = render(
      <InkApp state={this.state} callbacks={this.callbacks} />,
      {
        exitOnCtrlC: false,
        patchConsole: false,
        incrementalRendering: true,
      },
    );
  }

  private setupCallbacks(): void {
    this.callbacks = {
      onSubmit: (input: string) => {
        this.state = { ...this.state, input: '' };
        this.render();
        this.onInput?.(input);
      },
      onAbort: () => {
        this.onAbort?.();
      },
      onInterrupt: () => {
        this.onInterrupt?.();
      },
      onInputChange: (input: string) => {
        this.state = { ...this.state, input };
        this.render();
      },
      onToggleDetail: () => {
        this.state = { ...this.state, detailMode: !this.state.detailMode };
        this.render();
      },
    };
  }

  private render(): void {
    this.inkInstance.rerender(
      <InkApp state={this.state} callbacks={this.callbacks} />,
    );
  }

  private addLine(type: OutputLineType, content: string, meta?: Record<string, unknown>): void {
    const id = this.state.nextId;
    this.state = {
      ...this.state,
      lines: [...this.state.lines, { id, type, content, meta }],
      nextId: id + 1,
    };
  }

  private processLine(line: string): void {
    if (line.startsWith('```')) {
      if (this.inCodeBlock) {
        this.addLine('code_block', '', {
          language: this.codeBlockLanguage,
          code: this.codeBlockLines.join('\n'),
        });
        this.inCodeBlock = false;
        this.codeBlockLanguage = '';
        this.codeBlockLines = [];
      } else {
        this.inCodeBlock = true;
        this.codeBlockLanguage = line.slice(3).trim();
      }
      return;
    }

    if (this.inCodeBlock) {
      this.codeBlockLines.push(line);
      return;
    }

    if (!line.trim()) {
      this.addLine('empty', '');
      return;
    }

    if (/^#{1,6}\s/.test(line)) {
      this.addLine('header', line);
    } else if (/^\|.*\|$/.test(line) && line.includes('|', 1)) {
      this.addLine('table', line);
    } else if (line.startsWith('> ')) {
      this.addLine('blockquote', line);
    } else if (/^(\s*)([-*+]\s|\d+\.\s)/.test(line)) {
      this.addLine('list', line);
    } else if (/^[-*_]{3,}\s*$/.test(line)) {
      this.addLine('separator', '');
    } else {
      this.addLine('text', line);
    }
  }

  // ─── Public API (FluxUI-compatible) ──────────────────────────

  start(): void {
    // Ink is already rendering
  }

  destroy(): void {
    this.inkInstance.unmount();
  }

  appendMessage(content: string): void {
    const lines = content.split('\n');
    for (const line of lines) {
      this.processLine(line);
    }
    this.render();
  }

  appendDelta(delta: string): void {
    const parts = delta.split('\n');

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      if (i < parts.length - 1) {
        // Complete line — prepend any buffered partial then render
        const completeLine = this.pendingPartial + part;
        this.pendingPartial = '';
        this.processLine(completeLine);
      } else {
        // Partial line — buffer it for the next delta chunk
        this.pendingPartial += part;
      }
    }

    this.render();
  }

  flushOutput(): void {
    if (this.pendingPartial) {
      this.processLine(this.pendingPartial);
      this.pendingPartial = '';
      this.render();
    }
  }

  setInput(input: string): void {
    this.state = { ...this.state, input };
    this.render();
  }

  showToolCall(name: string, args: unknown): void {
    this.currentToolName = name;
    this.addLine('tool_call', name, { args });
    this.render();
  }

  showToolResult(name: string, content: string, isError: boolean): void {
    this.addLine('tool_result', name, { fullContent: content, isError });
    this.lastToolResult = { name, content, isError };
    this.render();
  }

  toggleDetailMode(): boolean {
    this.state = { ...this.state, detailMode: !this.state.detailMode };
    this.render();
    return this.state.detailMode;
  }

  showSpinner(text: string): void {
    this.state = { ...this.state, spinner: text };
    this.render();
  }

  updateSpinner(text: string): void {
    this.state = { ...this.state, spinner: text };
    this.render();
  }

  hideSpinner(): void {
    this.state = { ...this.state, spinner: null };
    this.render();
  }

  updateStatus(info: StatusBarInfo): void {
    this.state = { ...this.state, status: info };
    this.render();
  }

  showError(msg: string): void {
    this.addLine('error', msg);
    this.render();
  }

  showSystem(msg: string): void {
    this.addLine('system', msg);
    this.render();
  }

  showSeparator(): void {
    this.addLine('separator', '');
    this.render();
  }

  showDiff(diffText: string): void {
    // Render diff lines with +/- coloring
    const lines = diffText.split('\n');
    for (const line of lines) {
      if (line.startsWith('+') && !line.startsWith('+++')) {
        this.addLine('text', line); // Will be rendered as bold green via prefix detection
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        this.addLine('text', line);
      } else {
        this.addLine('text', line);
      }
    }
    this.render();
  }

  setProcessing(processing: boolean): void {
    this.state = { ...this.state, processing };
    this.render();
  }

  get detailMode(): boolean {
    return this.state.detailMode;
  }

  /**
   * Set the input buffer display (called from external raw-mode handler).
   * Alternative to setInput when using readline.
   */
  displayInput(input: string): void {
    this.state = { ...this.state, input };
    this.render();
  }
}
