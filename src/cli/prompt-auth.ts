import { createInterface } from 'node:readline';
import type { AuthRequest, AuthDecision } from '../core/auth.js';
import { formatAuthPrompt, parseAuthAnswer } from '../core/auth.js';

/**
 * Prompt the user for an auth decision via stdin/stderr.
 * Temporarily exits raw mode (if set by Ink) and re-enters after.
 */
export async function promptForAuthDecision(req: AuthRequest): Promise<AuthDecision> {
  // Temporarily exit raw mode so readline works
  const wasRaw = process.stdin.isTTY && process.stdin.setRawMode;
  if (wasRaw) {
    try { process.stdin.setRawMode(false); } catch { /* ignore */ }
  }

  return new Promise<AuthDecision>((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stderr,
    });

    rl.question(formatAuthPrompt(req), (answer: string) => {
      rl.close();

      // Re-enter raw mode for Ink
      if (wasRaw) {
        try { process.stdin.setRawMode(true); } catch { /* ignore */ }
      }

      // Drain any leftover input from stdin so Ink doesn't pick up stray chars
      if (process.stdin.isTTY) {
        try {
          process.stdin.pause();
          process.stdin.resume();
        } catch { /* ignore */ }
      }

      resolve(parseAuthAnswer(answer));
    });
  });
}
