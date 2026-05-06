/**
 * Hello World Example — Flux CLI
 *
 * A simple demonstration of how Flux works as a multi-agent AI CLI.
 * Run: npx tsx examples/hello-world.ts
 */

// ─── Example 1: Basic Agent Creation ───────────────────────────────────────────

console.log("╔══════════════════════════════════════════════════════════════╗");
console.log("║               Flux CLI — Hello World Example                 ║");
console.log("╚══════════════════════════════════════════════════════════════╝");
console.log();

// Simulate creating agents
console.log("─── Example 1: Creating Agents ───");
console.log();

const agents = [
  { name: "architect", model: "claude-sonnet-4-20250505", role: "System designer" },
  { name: "coder", model: "claude-haiku-3-5-20241022", role: "Implementation" },
  { name: "reviewer", model: "claude-sonnet-4-20250505", role: "Quality assurance" },
];

for (const agent of agents) {
  console.log(`  ✅ Agent "${agent.name}" created`);
  console.log(`     Model: ${agent.model}`);
  console.log(`     Role:  ${agent.role}`);
  console.log();
}

// ─── Example 2: Bridge Communication ──────────────────────────────────────────

console.log("─── Example 2: Bridge Communication ───");
console.log();

console.log("  Bridging agents...");
console.log("  ┌──────────┐     ┌──────────┐     ┌──────────┐");
console.log("  │ Architect│ ←── │   Coder  │ ←── │ Reviewer │");
console.log("  │ (Sonnet) │ ──→ │  (Haiku) │ ──→ │ (Sonnet) │");
console.log("  └──────────┘     └──────────┘     └──────────┘");
console.log("       │               │                │");
console.log("       └───────────────┼────────────────┘");
console.log("                       │");
console.log("                ┌──────▼──────┐");
console.log("                │   Bridge    │");
console.log("                │  (事件路由)  │");
console.log("                └──────┬──────┘");
console.log("                       │");
console.log("                ┌──────▼──────┐");
console.log("                │    User     │");
console.log("                └─────────────┘");
console.log();

// ─── Example 3: Multi-Agent Workflow ──────────────────────────────────────────

console.log("─── Example 3: Multi-Agent Workflow ───");
console.log();

const workflow = [
  { step: 1, agent: "User", action: 'Says: "Build a REST API for a todo list"' },
  { step: 2, agent: "Architect", action: "Designs data model, API spec, routes" },
  { step: 3, agent: "Coder", action: "Implements the code based on spec" },
  { step: 4, agent: "Reviewer", action: "Reviews for bugs, edge cases, style" },
  { step: 5, agent: "Architect", action: "Finalizes and presents to user" },
];

for (const { step, agent, action } of workflow) {
  console.log(`  Step ${step}: [${agent}] ${action}`);
}
console.log();

// ─── Example 4: Session (JSONL) ───────────────────────────────────────────────

console.log("─── Example 4: Session Logging (JSONL format) ───");
console.log();

const sessionLogs = [
  { t: 1712345678, type: "message", agent: "default", role: "user", content: "hello" },
  { t: 1712345679, type: "message", agent: "default", role: "assistant", content: "Hi! How can I help?", model: "claude-sonnet-4-20250505", tokens_in: 10, tokens_out: 5 },
  { t: 1712345680, type: "tool_call", agent: "default", tool: "read_file", args: { path: "src/index.ts" }, result: { content: "..." } },
];

for (const log of sessionLogs) {
  console.log(`  ${JSON.stringify(log)}`);
}
console.log();

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log("─── Summary ───");
console.log();
console.log("  Flux transforms CLI interactions from single-agent to multi-agent.");
console.log("  Key concepts demonstrated:");
console.log("    • Agent — Independent AI actor with persona, tools, session");
console.log("    • Bridge — Agent-to-agent coordination bus");
console.log("    • Session — JSONL-based full-context persistence");
console.log("    • Provider — Model-agnostic LLM abstraction");
console.log();
console.log("  For more, see: ARCHITECTURE.md, src/core/, src/cli/");
console.log();
