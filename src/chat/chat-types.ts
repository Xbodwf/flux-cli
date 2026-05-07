// ─── Chat Message Types ─────────────────────────────────────────────

export type MessageRole = 'user' | 'assistant' | 'scanner' | 'system';

export interface ToolCallDisplay {
  id: string;
  name: string;
  args: unknown;
  result?: {
    content: string;
    isError: boolean;
  };
}

/**
 * A single chat message — maps to a "paragraph" of AI output or one user submission.
 * In real-time mode, AI output is split into multiple ChatMessages on paragraph boundaries.
 *
 * agentId differentiates which agent produced the message when multiple agents
 * share a conversation context (session).
 */
export interface ChatMessage {
  id: number;
  role: MessageRole;
  /** Agent that produced this message. Required for assistant/scanner roles to distinguish
   *  between agents in shared context. For 'user' role, may be undefined. */
  agentId?: string;
  /** Display name of the agent (from agent.config.name), for user-facing labels. */
  agentName?: string;
  content: string;
  quotedMessageId: number | null;
  timestamp: number;
  toolCalls: ToolCallDisplay[];
  isStreaming: boolean;
}

/**
 * Extract quoted message ID from text like ">123 rest of message"
 * or "> [msg-123] rest of message"
 */
export function parseQuoteRef(text: string): { quoteId: number | null; cleanText: string } {
  // Match: >123 at start, or > [msg-123]
  const inlineMatch = text.match(/^>(\d+)\s*/);
  if (inlineMatch) {
    return { quoteId: parseInt(inlineMatch[1]!, 10), cleanText: text.slice(inlineMatch[0].length) };
  }

  const bracketMatch = text.match(/^>\s*\[msg-(\d+)\]\s*/);
  if (bracketMatch) {
    return { quoteId: parseInt(bracketMatch[1]!, 10), cleanText: text.slice(bracketMatch[0].length) };
  }

  return { quoteId: null, cleanText: text };
}

/**
 * Parse quote refs from AI output — looks for `> [msg-NNN]` inline patterns
 * and returns the IDs found. The actual rendering strips these markers.
 */
export function findQuoteRefs(text: string): number[] {
  const ids: number[] = [];
  const regex = />\s*\[msg-(\d+)\]\s*/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(text)) !== null) {
    ids.push(parseInt(m[1]!, 10));
  }
  return [...new Set(ids)];
}

/**
 * Strip quote markers like "> [msg-123]" from text for clean display.
 */
export function stripQuoteMarkers(text: string): string {
  return text.replace(/>\s*\[msg-\d+\]\s*/g, '').replace(/^>\d+\s*/gm, '').trim();
}
