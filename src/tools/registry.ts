import type { ToolDefinition, ToolResult } from '../core/types.js';

/**
 * ToolRegistry — manages tool definitions that agents can invoke.
 *
 * Tools are registered by name and can be scoped per-agent.
 * Built-in tools are registered at startup; external tools can
 * be added via MCP.
 */
export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  /**
   * Register a tool.
   */
  register(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  /**
   * Register multiple tools at once.
   */
  registerMany(tools: ToolDefinition[]): void {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  /**
   * Get a tool by name.
   */
  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  /**
   * Remove a tool.
   */
  unregister(name: string): void {
    this.tools.delete(name);
  }

  /**
   * List all registered tool names.
   */
  list(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  /**
   * Get tool definitions in LLM API format (name + schema only, no handler).
   */
  getDefinitions(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
    return Array.from(this.tools.values()).map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
  }

  /**
   * Execute a tool by name.
   */
  async execute(name: string, args: unknown): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return {
        content: [{ type: 'error', data: `Tool not found: ${name}` }],
        isError: true,
      };
    }
    return tool.handler(args);
  }

  /**
   * Check if a tool exists.
   */
  has(name: string): boolean {
    return this.tools.has(name);
  }
}
