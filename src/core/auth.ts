import { homedir } from 'node:os';

// ─── Types ────────────────────────────────────────────────

export type AuthOperation = 'read' | 'write' | 'shell';
export type AuthDecision = 'grant_once' | 'grant_session' | 'grant_session_recursive' | 'deny';

export interface AuthRequest {
  id: string;
  agentName: string;
  operation: AuthOperation;
  /** File path (for read/write) */
  path?: string;
  /** Shell command (for shell operation) */
  command?: string;
  resolve: (decision: AuthDecision) => void;
  promise: Promise<AuthDecision>;
}

/**
 * Format an auth request as a user-facing prompt string.
 */
export function formatAuthPrompt(req: AuthRequest): string {
  const opLabel = { read: 'read', write: 'write to', shell: 'run a shell command' }[req.operation];
  const target = req.path ? `\n  File: ${req.path}` : '';
  const cmd = req.command ? `\n  Command: ${req.command}` : '';
  return [
    `\n${req.agentName} wants to ${opLabel}:${target}${cmd}`,
    '',
    '  [a] Allow once',
    '  [s] Allow for this session',
    '  [r] Allow for this session + parent directory (recursive)',
    '  [d] Deny',
    '',
    '  Choice (a/s/r/d): ',
  ].join('\n');
}

/**
 * Parse a single-character auth response.
 */
export function parseAuthAnswer(answer: string): AuthDecision {
  const c = answer.trim().toLowerCase();
  if (c === 'a') return 'grant_once';
  if (c === 's') return 'grant_session';
  if (c === 'r') return 'grant_session_recursive';
  return 'deny';
}

// ─── Authorizer ───────────────────────────────────────────

/**
 * Authorizer — manages file/shell operation permissions.
 *
 * Permission levels:
 * - grant_once: single operation only
 * - grant_session: all operations in current session (in-memory only)
 * - grant_session_recursive: session grant + all paths under the same parent or ancestor
 */
export class Authorizer {
  /** Granted paths for session-level permissions: path → true */
  private sessionGrants = new Set<string>();
  /** Granted path prefixes for recursive permissions */
  private recursiveGrants: string[] = [];

  private pendingRequest: AuthRequest | null = null;
  private nextId = 0;

  /** Callback invoked when user authorization is needed. Set by the REPL. */
  onAuthNeeded: ((req: AuthRequest) => void) | null = null;

  /**
   * Check if a file read is allowed. Returns the decision or null if pending.
   */
  async checkRead(agentName: string, path: string): Promise<AuthDecision> {
    const resolved = this.resolvePath(path);
    if (this.isGranted(resolved)) return 'grant_session';
    return this.requestAuth(agentName, 'read', resolved);
  }

  /**
   * Check if a file write is allowed.
   */
  async checkWrite(agentName: string, path: string): Promise<AuthDecision> {
    const resolved = this.resolvePath(path);
    if (this.isGranted(resolved)) return 'grant_session';
    return this.requestAuth(agentName, 'write', resolved);
  }

  /**
   * Check if a shell command is allowed.
   */
  async checkShell(agentName: string, command: string): Promise<AuthDecision> {
    return this.requestAuth(agentName, 'shell', undefined, command);
  }

  /**
   * Record a grant so subsequent checks pass.
   */
  recordGrant(path: string | undefined, decision: AuthDecision): void {
    if (!path) return;
    const resolved = this.resolvePath(path);

    if (decision === 'grant_session') {
      this.sessionGrants.add(resolved);
    } else if (decision === 'grant_session_recursive') {
      this.recursiveGrants.push(resolved);
      // Also grant the exact path
      this.sessionGrants.add(resolved);
    }
  }

  /**
   * Check if a path is already granted.
   */
  private isGranted(resolvedPath: string): boolean {
    // Exact path match
    if (this.sessionGrants.has(resolvedPath)) return true;
    // Recursive: check if any parent is recursively granted
    for (const prefix of this.recursiveGrants) {
      if (resolvedPath.startsWith(prefix)) return true;
    }
    return false;
  }

  /**
   * Create a pending auth request and return a promise.
   */
  private requestAuth(
    agentName: string,
    operation: AuthOperation,
    path?: string,
    command?: string,
  ): Promise<AuthDecision> {
    const id = `auth-${this.nextId++}`;

    const request: Partial<AuthRequest> = {
      id,
      agentName,
      operation,
      path,
      command,
    };

    // Create the promise that resolves when the user responds
    request.promise = new Promise<AuthDecision>((resolve) => {
      request.resolve = resolve;
    });

    this.pendingRequest = request as AuthRequest;

    // Notify the REPL so it can prompt the user
    this.onAuthNeeded?.(this.pendingRequest);

    return this.pendingRequest.promise;
  }

  /**
   * Get the current pending auth request (null if none).
   */
  getPendingRequest(): AuthRequest | null {
    return this.pendingRequest;
  }

  /**
   * Resolve the current pending auth request.
   */
  resolvePending(decision: AuthDecision): void {
    const req = this.pendingRequest;
    if (!req) return;
    this.pendingRequest = null;
    this.recordGrant(req.path, decision);
    req.resolve(decision);
  }

  /**
   * Cancel/deny the current pending auth request.
   */
  cancelPending(): void {
    const req = this.pendingRequest;
    if (!req) return;
    this.pendingRequest = null;
    req.resolve('deny');
  }

  /**
   * Clear all session-level grants (called on session new/load).
   */
  clearSessionGrants(): void {
    this.sessionGrants.clear();
    this.recursiveGrants = [];
    this.cancelPending();
  }

  /**
   * Resolve a path to its absolute canonical form.
   */
  private resolvePath(path: string): string {
    if (path.startsWith('~/') || path === '~') {
      return path.replace('~', homedir());
    }
    return path;
  }
}

// ─── Singleton ────────────────────────────────────────────

export const authorizer = new Authorizer();
