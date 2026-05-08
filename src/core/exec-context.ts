/**
 * Execution context — allows tool handlers to know which agent is calling them.
 * Set before each tool handler invocation, read inside the handler.
 */

let currentAgentName = '';

export function setCurrentAgentName(name: string): void {
  currentAgentName = name;
}

export function getCurrentAgentName(): string {
  return currentAgentName;
}
