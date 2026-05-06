/**
 * ANSI terminal control utilities.
 *
 * Low-level escape sequences for cursor movement, screen manipulation,
 * and text styling. Higher-level rendering lives in ./ui.ts.
 */

// ─── Screen ───────────────────────────────────────────────────

/** Enter alternate screen buffer (like vim fullscreen) */
export const enterAltScreen = '\x1b[?1049h';

/** Exit alternate screen buffer */
export const exitAltScreen = '\x1b[?1049l';

/** Clear entire screen */
export const clearScreen = '\x1b[2J';

/** Clear from cursor to end of line */
export const clearLine = '\x1b[K';

/** Clear from cursor to end of screen */
export const clearBelow = '\x1b[J';

/** Hide cursor */
export const hideCursor = '\x1b[?25l';

/** Show cursor */
export const showCursor = '\x1b[?25h';

// ─── Cursor ───────────────────────────────────────────────────

/** Move cursor to (row, col) — 1-indexed */
export function cursorTo(row: number, col = 0): string {
  return `\x1b[${row};${col || 1}H`;
}

/** Move cursor up N lines */
export function cursorUp(n = 1): string {
  return `\x1b[${n}A`;
}

/** Move cursor down N lines */
export function cursorDown(n = 1): string {
  return `\x1b[${n}B`;
}

/** Move cursor right N columns */
export function cursorRight(n = 1): string {
  return `\x1b[${n}C`;
}

/** Move cursor left N columns */
export function cursorLeft(n = 1): string {
  return `\x1b[${n}D`;
}

/** Save cursor position */
export const saveCursor = '\x1b[s';

/** Restore cursor position */
export const restoreCursor = '\x1b[u';

/** Move cursor to beginning of current row */
export const cursorToRowStart = '\r';

// ─── Scrolling ────────────────────────────────────────────────

/** Scroll terminal up N lines */
export function scrollUp(n = 1): string {
  return `\x1b[${n}S`;
}

/** Scroll terminal down N lines */
export function scrollDown(n = 1): string {
  return `\x1b[${n}T`;
}

// ─── Terminal Info ────────────────────────────────────────────

/** Get terminal width */
export function terminalWidth(): number {
  return process.stdout.columns || 80;
}

/** Get terminal height */
export function terminalHeight(): number {
  return process.stdout.rows || 24;
}

/** Get terminal size as tuple [width, height] */
export function terminalSize(): [number, number] {
  return [terminalWidth(), terminalHeight()];
}

// ─── Decorative helpers ───────────────────────────────────────

/** Draw a horizontal separator line */
export function separatorLine(char = '─', title?: string): string {
  const width = terminalWidth();
  if (title) {
    const padded = ` ${title} `;
    const left = char.repeat(Math.max(0, Math.floor((width - padded.length) / 2)));
    const right = char.repeat(Math.max(0, width - left.length - padded.length));
    return left + padded + right;
  }
  return char.repeat(width);
}
