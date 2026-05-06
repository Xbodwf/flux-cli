import { hideCursor, showCursor } from './ansi.js';

/**
 * A simple spinner for indicating loading/thinking states.
 *
 * Uses Unicode braille characters for smooth animation.
 * Draws to stderr so stdout remains clean for pipe mode.
 */

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const INTERVAL_MS = 80;

export class Spinner {
  private frame = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private text = '';
  private started = false;

  /** Start the spinner with a message. */
  start(text: string): void {
    this.text = text;
    this.frame = 0;

    if (this.started) return;
    this.started = true;

    process.stderr.write(hideCursor);

    this.timer = setInterval(() => {
      this.frame = (this.frame + 1) % FRAMES.length;
      this.draw();
    }, INTERVAL_MS);

    this.draw();
  }

  /** Update the message without restarting. */
  setText(text: string): void {
    this.text = text;
    if (this.started) this.draw();
  }

  /** Stop the spinner and clean up. */
  stop(finalMessage?: string): void {
    if (!this.started) return;
    this.started = false;

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    // Clear the spinner line
    process.stderr.write('\r\x1b[K');

    if (finalMessage) {
      process.stderr.write(finalMessage + '\n');
    }

    process.stderr.write(showCursor);
  }

  /** Stop with a success checkmark. */
  succeed(text: string): void {
    this.stop(`  ${text}`);
  }

  /** Stop with a failure cross. */
  fail(text: string): void {
    this.stop(`  ${text}`);
  }

  private draw(): void {
    const frame = FRAMES[this.frame];
    if (frame === undefined) return;
    process.stderr.write(`\r\x1b[K${frame} ${this.text}`);
  }
}
