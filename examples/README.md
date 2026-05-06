# Flux CLI Examples

This directory contains example files demonstrating various Flux CLI features.

## Files

| File | Description |
|------|-------------|
| `hello-world.ts` | Simple introduction to agents, bridge, and session concepts |
| `multi-agent-workflow.ts` | Simulated Architect → Coder → Reviewer collaboration workflow |
| `session-format.jsonl` | Example JSONL session log format |

## How to Run

```bash
# Run TypeScript examples
npx tsx examples/hello-world.ts
npx tsx examples/multi-agent-workflow.ts

# View session format
cat examples/session-format.jsonl
```

## What These Examples Cover

- **Agents** — Creating AI agents with different models and personas
- **Bridge** — Agent-to-agent communication coordination
- **Sessions** — JSONL-based conversation persistence format
- **Multi-agent workflow** — How agents collaborate on a task
- **Tool calling** — Agents invoking tools and processing results

## See Also

- [ARCHITECTURE.md](../ARCHITECTURE.md) — Full system architecture
- [src/](../src/) — Source code
