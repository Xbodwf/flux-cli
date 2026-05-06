import chalk from 'chalk';
import { hideCursor, showCursor, clearLine, cursorTo } from './ansi.js';
import {
  renderMarkdownLine,
  renderCodeBlock,
  renderDiff,
  renderToolCall,
  renderToolResultWithContent,
  renderError,
} from './markdown.js';
import { Spinner } from './spinner.js';
import { t } from '../i18n/index.js';

/**
 * FluxUI — high-level UI manager for the REPL.
 *
 * Manages:
 * - Output area (scrollable message history)
 * - Status bar (model, tokens, time)
 * - Spinner (thinking indicator)
 * - Code block rendering
 * - Diff rendering
 */

export interface StatusBarInfo {
  model: string;
  tokensIn?: number;
  tokensOut?: number;
  agentName?: string;
}

export class FluxUI {
  private spinner = new Spinner();
  private statusInfo: StatusBarInfo | null = null;
  private statusInterval: ReturnType<typeof setInterval> | null = null;
  private linesOutput = 0;
  private inCodeBlock = false;
  private codeBlockLanguage = '';
  private codeBlockLines: string[] = [];
  private detailMode = false;
  private pendingPartial = '';

  /** Current output content (for status bar positioning) */
  private outputBuffer: string[] = [];

  constructor() {
    process.stdout.write(hideCursor);
  }

  /**
   * Start the REPL UI — draws the initial state.
   */
  start(): void {
    this.startStatusBar();
  }

  /**
   * Clean up on exit.
   */
  destroy(): void {
    this.spinner.stop();
    this.stopStatusBar();
    process.stdout.write(showCursor);
  }

  // ─── Output ─────────────────────────────────────────────────

  /**
   * Append a markdown-rendered message to the output area.
   */
  appendMessage(content: string): void {
    const lines = content.split('\n');

    for (const line of lines) {
      this.renderOutputLine(line);
    }
  }

  /**
   * Append text delta to the output (for streaming).
   */
  appendDelta(delta: string): void {
    const parts = delta.split('\n');

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;

      if (i < parts.length - 1) {
        // Complete line — prepend any buffered partial then render
        const completeLine = this.pendingPartial + part;
        this.pendingPartial = '';
        this.outputBuffer.push(completeLine);
        this.renderOutputLine(completeLine);
      } else {
        // Partial line — buffer it for the next delta chunk
        this.pendingPartial += part;
      }
    }
  }

  /**
   * Flush the output buffer (when a stream ends).
   */
  flushOutput(): void {
    if (this.pendingPartial) {
      this.renderOutputLine(this.pendingPartial);
      this.pendingPartial = '';
    }
    process.stdout.write('\n');
  }

  private renderOutputLine(line: string): void {
    // Handle code block state machine
    if (line.startsWith('```')) {
      if (this.inCodeBlock) {
        // End code block — render it
        const language = this.codeBlockLanguage;
        const code = this.codeBlockLines.join('\n');
        const rendered = renderCodeBlock(code, language);
        process.stdout.write('\n' + rendered + '\n\n');

        this.inCodeBlock = false;
        this.codeBlockLanguage = '';
        this.codeBlockLines = [];
      } else {
        // Start code block
        this.inCodeBlock = true;
        this.codeBlockLanguage = line.slice(3).trim();
      }
      return;
    }

    if (this.inCodeBlock) {
      this.codeBlockLines.push(line);
      return;
    }

    // Regular markdown line
    const rendered = renderMarkdownLine(line);
    if (rendered) {
      process.stdout.write(rendered + '\n');
    } else {
      process.stdout.write('\n');
    }
  }

  // ─── Tool calls ─────────────────────────────────────────────

  /**
   * Show a tool call in the output.
   */
  showToolCall(name: string, args: unknown): void {
    process.stdout.write('\n' + renderToolCall(name, args) + '\n');
  }

  /**
   * Show a tool result in the output (with content, foldable).
   */
  showToolResult(name: string, content: string, isError: boolean): void {
    process.stdout.write(renderToolResultWithContent(name, content, isError, this.detailMode) + '\n');
  }

  /**
   * Toggle detail mode for tool result display.
   */
  toggleDetailMode(): boolean {
    this.detailMode = !this.detailMode;
    return this.detailMode;
  }

  // ─── Spinner ────────────────────────────────────────────────

  /**
   * Show the thinking spinner.
   */
  showSpinner(text: string): void {
    this.spinner.start(text);
  }

  /**
   * Update spinner text.
   */
  updateSpinner(text: string): void {
    this.spinner.setText(text);
  }

  /**
   * Stop the spinner.
   */
  hideSpinner(): void {
    this.spinner.stop();
  }

  // ─── Diff ───────────────────────────────────────────────────

  /**
   * Render a diff block.
   */
  showDiff(diffText: string): void {
    process.stdout.write('\n' + renderDiff(diffText) + '\n');
  }

  // ─── Status Bar ─────────────────────────────────────────────

  /**
   * Update and draw the status bar.
   */
  updateStatus(info: StatusBarInfo): void {
    this.statusInfo = info;
    this.drawStatusBar(info);
  }

  private startStatusBar(): void {
    // Status bar is updated on-demand via updateStatus()
  }

  private stopStatusBar(): void {
  }

  private drawStatusBar(info: StatusBarInfo): void {
    const width = process.stdout.columns || 80;

    const tokens = info.tokensIn || info.tokensOut
      ? chalk.dim(t('status.tokens', { in: info.tokensIn || '?', out: info.tokensOut || '?' }))
      : '';

    const model = chalk.dim(info.model);
    const agent = info.agentName ? chalk.dim(`[${info.agentName}]`) : '';

    const left = `${model} ${agent}`;
    const right = tokens;

    // Calculate padding
    const padding = Math.max(1, width - left.length - right.length - 2);

    // Write to stderr as its own line so it doesn't interfere with readline on stdout
    process.stderr.write(`\n${clearLine}${left}${' '.repeat(padding)}${right}\n`);
  }

  // ─── Error ──────────────────────────────────────────────────

  /**
   * Render an error message.
   */
  showError(msg: string): void {
    process.stdout.write('\n' + renderError(msg) + '\n');
  }

  /**
   * Render a system notification.
   */
  showSystem(msg: string): void {
    process.stdout.write('\n' + chalk.dim.italic('── ' + msg) + '\n');
  }

  // ─── Separator ──────────────────────────────────────────────

  /**
   * Draw a thin separator line.
   */
  showSeparator(): void {
    process.stdout.write(chalk.dim('─'.repeat(Math.min(process.stdout.columns || 80, 40))) + '\n');
  }
}
