# Weave Architecture

> Weave — A next-generation AI CLI with multi-agent coordination, model-agnostic design, and session-aware persistence.

## Philosophy

Existing AI CLI tools (Claude Code, Codex, Gemini CLI) follow a **single-agent** pattern:
one user, one LLM, one conversation. Weave inverts this by treating AI agents as
**cooperative peers** rather than single chat completions. The core insight:

> **The ceiling of a solo agent is the ceiling of its model. The ceiling of
> coordinated agents is unbounded.**

Weave is designed from the ground up for **multi-agent coordination**, not just
multi-turn chat. Different models with different roles run side-by-side,
communicating through a structured Bridge layer — turning user+AI into
user+team-of-AIs.

---

## Core Concepts

### 1. Agent

The fundamental execution unit. Each agent is an independent actor with:

- A **Provider** (which LLM backend to use — Anthropic, OpenAI, Google, local)
- A **Model** (specific model name — `claude-sonnet-4-20250505`, `gpt-4o`, `gemini-2.5-pro`, `ollama/qwen2.5`)
- A **Persona** (system prompt + behavioral configuration)
- A **Tool Registry** (what tools this agent can invoke)
- A **Session** (its own conversation history, in JSONL)

```
Agent {
  id:        string
  name:      string
  provider:  ProviderType      // "anthropic" | "openai" | "google" | "ollama"
  model:     string
  persona:   Persona           // system prompt, temperature, rules
  tools:     ToolRegistry
  session:   Session           // private conversation history
  status:    "idle" | "thinking" | "awaiting_tools" | "done" | "error"
}
```

Agents are **first-class citizens** — they can be created, listed, inspected, and
destroyed at runtime through CLI commands.

### 2. Bridge

The coordination bus. The Bridge enables agents to communicate with each other,
not just with the user. This is Weave's primary innovation over existing tools.

```
     ┌──────────┐     ┌──────────┐     ┌──────────┐
     │ Architect│     │  Coder   │     │ Reviewer │
     │ (Sonnet) │     │ (Haiku)  │     │ (Sonnet) │
     └────┬─────┘     └────┬─────┘     └────┬─────┘
          │                │                │
          └────────────────┼────────────────┘
                           │
                    ┌──────▼──────┐
                    │   Bridge    │
                    │ (事件路由)   │
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │    User     │
                    └─────────────┘
```

Bridge supports three communication modes:

| Mode | Description | When to Use |
|------|-------------|-------------|
| **Broadcast** | One agent publishes, all others receive | Status updates, announcements |
| **Direct** | Agent-to-agent directed message | Architect asks Coder to implement specific function |
| **Topic** | Pub/sub on named channels (`#review`, `#design`) | Agents subscribe to relevant topics |

Example coordination flow:

```
User: "Build a REST API for todo list"

Architect(Sonnet):
  → designs data model, API spec
  → Bridge.send({ to: "coder", type: "direct", spec })

Coder(Haiku):
  → implements based on spec
  → Bridge.send({ to: "reviewer", type: "direct", code })

Reviewer(Sonnet):
  → reviews for bugs, style, edge cases
  → Bridge.send({ to: "user", type: "direct", review })
```

### 3. Event Bus

Internal pub/sub system for system-level events. Different from the Bridge
(which is agent-to-agent communication), the Event Bus handles internal
observability and lifecycle:

- `agent:spawned` — A new agent was created
- `agent:thinking` — Agent started generating
- `agent:response` — Agent produced a message
- `agent:error` — Agent hit an error
- `tool:called` — A tool was invoked
- `tool:result` — A tool returned
- `session:save` — Session checkpoint saved
- `user:input` — User submitted input

This enables:
- **Observability dashboards** (see what each agent is doing in real-time)
- **Hooks** (trigger actions on events)
- **Logging** (structured event log for debugging)

### 4. LLM Provider Layer

Abstract interface that all LLM backends implement:

```
Provider {
  name:       string
  chat():     AsyncIterable<StreamEvent>
  models():   string[]
  tokenCount(text): number
}

StreamEvent = TextDelta | ToolCall | ToolResult | Stop
```

Built-in providers:
- **Anthropic** — Claude models (Claude Code-compatible)
- **OpenAI** — GPT-4o, o-series
- **Google** — Gemini 2.5 Pro/Flash
- **Ollama** — Local models (Qwen, DeepSeek, Llama)
- **OpenAI-compatible** — Any OpenAI-compatible endpoint

### 5. Persona System

Each agent has a persona — a structured definition of its role, behavior, and
constraints. Personas are stored as YAML files in `~/.weave_conf/personas/`.

```yaml
# ~/.weave_conf/personas/architect.yaml
name: architect
description: "System architect — designs solutions, produces specs"
prompt: |
  You are a senior software architect. Given a feature request:
  1. Analyze requirements and ask clarifying questions if needed
  2. Design data models and API interfaces
  3. Produce a step-by-step implementation plan
  4. Pass the spec to the coder agent when done

  Always think in terms of:
  - Data flow and state management
  - Error handling and edge cases
  - Performance and scalability
model_preference: sonnet
temperature: 0.2
```

Built-in personas are shipped with Weave; users can override or add their own.

### 6. Session (JSONL Format)

Every conversation is stored as **JSONL** (one JSON object per line), preserving
the full structured content including:

- Turn metadata (agent_id, timestamp, model, token counts)
- Messages (role, content, tool_calls)
- Tool call requests and results
- System events
- Agent state snapshots

```
{"t": 1712345678, "type": "message", "agent": "default", "role": "user",  "content": "hello"}
{"t": 1712345679, "type": "message", "agent": "default", "role": "assistant", "content": "Hi!", "model": "claude-sonnet-4-20250505", "tokens_in": 10, "tokens_out": 5}
{"t": 1712345680, "type": "tool_call", "agent": "default", "tool": "read_file", "args": {"path": "src/index.ts"}, "result": {...}}
```

**Compression**: Sessions can be gzip-compressed (`.jsonl.gz`) while preserving
full text — decompression is lossless. This avoids the problem of lossy
summarization seen in other tools.

**Resume**: Any session file can be loaded to restore full context, including
all agent states, tool results, and system events.

### 7. Configuration (`~/.weave_conf/`)

```
~/.weave_conf/
├── config.yaml          # Main configuration file
├── providers.yaml       # LLM provider settings & API keys
├── keys.yaml            # API keys (0600 permissions)
├── hooks/               # Event hooks
│   └── pre_tool.yaml
└── personas/            # Agent personality definitions
    ├── default.yaml
    ├── architect.yaml
    ├── coder.yaml
    └── reviewer.yaml
```

Config is loaded at startup and watched for changes (hot-reload where possible).

---

## Data Flow

### Single-Agent Flow (simple mode)

```
User Input → CLI Layer → Agent Loop ──→ LLM Provider ──→ Stream ──→ User
                │            │                              │
                │            └── Tool Calls ──→ Tool Registry │
                │                              │             │
                │                              └── FS/Shell  │
                │                                            │
                └──── Session (JSONL) ←── every event ──────┘
```

### Multi-Agent Flow (bridge mode)

```
User Input → CLI Layer → Orchestrator Agent
                            │
                            │ (analyze & decompose)
                            ▼
                      ┌──────────┐
                      │  Bridge  │
                      └──┬────┬──┘
                         │    │
              ┌──────────┘    └──────────┐
              ▼                           ▼
        Architect Agent             Coder Agent
        (sonnet, t=0.2)           (haiku, t=0.3)
              │                           │
              │ spec                      │ code
              │                           │
              └──────────┬───────────────┘
                         │
                   Reviewer Agent
                   (sonnet, t=0.1)
                         │
                         │ review
                         ▼
                    User Output
```

---

## CLI Design

```bash
weave [command] [options] [input]

Commands:
  (none)      REPL mode — interactive terminal
  <query>     One-shot mode — run and exit
  agent       Agent management
    create    Create a new agent with persona
    list      List active agents
    rm        Remove an agent
    inspect   Inspect agent state & session
  session    Session management
    save      Save current session
    load      Load a session
    list      List saved sessions
    export    Export to markdown
  config     Configuration
    show      Show current config
    set       Set config value
    edit      Open in $EDITOR
  persona    Persona management
    list      List available personas
    create    Create a new persona
    edit      Edit a persona
  bridge     Multi-agent coordination
    connect   Bridge two agents
    route     Set up routing rules
    status    Show bridge topology

Pipe mode:
  echo "refactor this" | weave
  cat main.ts | weave "review this file"
```

---

## Project Structure

```
weave/
├── package.json
├── tsconfig.json
├── ARCHITECTURE.md
├── bin/
│   └── weave                 # CLI entry point (hashbang)
├── src/
│   ├── index.ts              # Main entry
│   ├── cli/
│   │   ├── repl.ts           # REPL mode (terminal UI)
│   │   ├── pipe.ts           # Pipe/one-shot mode
│   │   ├── commands.ts       # Command router
│   │   └── ui.ts             # Terminal rendering (ANSI/Rich)
│   ├── core/
│   │   ├── types.ts          # Core type definitions
│   │   ├── event-bus.ts      # Event bus (pub/sub)
│   │   ├── agent.ts          # Agent abstraction
│   │   ├── agent-manager.ts  # Agent lifecycle management
│   │   ├── bridge.ts         # Multi-agent coordination
│   │   └── session.ts        # Session serialization (JSONL)
│   ├── llm/
│   │   ├── provider.ts       # Abstract provider interface
│   │   ├── anthropic.ts      # Anthropic Claude provider
│   │   ├── openai.ts         # OpenAI provider
│   │   ├── google.ts         # Google Gemini provider
│   │   └── ollama.ts         # Local/ollama provider
│   ├── tools/
│   │   ├── registry.ts       # Tool registry
│   │   ├── filesystem.ts     # File read/write/edit
│   │   ├── shell.ts          # Command execution
│   │   ├── search.ts         # Code search (grep/glob)
│   │   └── mcp.ts            # MCP protocol client
│   ├── config/
│   │   ├── loader.ts         # Config loader (~/.weave_conf/)
│   │   └── schema.ts         # Config schema and types
│   ├── persona/
│   │   ├── manager.ts        # Persona lifecycle
│   │   └── builtin/          # Built-in personas
│   │       ├── default.yaml
│   │       ├── architect.yaml
│   │       ├── coder.yaml
│   │       └── reviewer.yaml
│   └── session/
│       ├── jsonl.ts          # JSONL writer/reader
│       └── compress.ts       # Gzip compression
```

---

## Tool System (MCP-based)

Tools are the agents' interface to the world. Weave uses the **Model Context
Protocol (MCP)** for tool definition, allowing both local and remote tools.

```typescript
interface Tool {
  name: string;
  description: string;
  inputSchema: JSONSchema;
  handler: (args: unknown) => Promise<ToolResult>;
}

interface ToolResult {
  content: Array<{ type: "text" | "image"; data: string }>;
  isError?: boolean;
}
```

Built-in tools:
- `read_file` / `write_file` / `edit_file` / `patch_file`
- `glob` / `grep`
- `bash` (sandboxed command execution)
- `web_fetch` / `web_search`

---

## Error Handling & Resilience

### Per-Agent Error Isolation
One agent crashing does not bring down the system. The Bridge detects agent
failures and can spawn replacement agents.

### Session Checkpointing
Session is checkpointed after every turn. If Weave crashes, restarting with
`weave session load` restores full state.

### Retry with Fallback Model
If an agent's primary model fails (rate limit, outage), it can fall back to a
secondary model transparently.

---

## Security Model

1. **API keys** stored in `~/.weave_conf/keys.yaml` with `chmod 0600`
2. **Shell execution** requires user confirmation by default (opt-in to auto)
3. **File operations** scoped to project directory by default
4. **Network tools** (`web_fetch`) require explicit enablement
5. **MCP remote tools** require user approval on first connection

---

## Implementation Roadmap

### Phase 1: Foundation
- [x] Project scaffolding (package.json, tsconfig)
- [ ] Core types and event bus
- [ ] Basic CLI entry (REPL + pipe)
- [ ] Config loader (~/.weave_conf/)
- [ ] JSONL session writer
- [ ] Single-provider (Anthropic) naive agent loop

### Phase 2: Multi-Provider
- [ ] Abstract provider interface
- [ ] OpenAI provider
- [ ] Google provider
- [ ] Ollama provider
- [ ] Provider fallback

### Phase 3: Multi-Agent
- [ ] Bridge (agent-to-agent communication)
- [ ] Agent lifecycle (create/list/inspect/rm)
- [ ] Persona system (YAML loading)
- [ ] Built-in personas (architect, coder, reviewer)

### Phase 4: Polish
- [ ] Terminal UI (ANSI rendering, spinners, diffs)
- [ ] Session resume with full context
- [ ] Compression (jsonl.gz)
- [ ] Tool system (filesystem, shell, search)
- [ ] MCP support

### Phase 5: Advanced
- [ ] Web search / web fetch
- [ ] Multi-turn planning
- [ ] Custom persona DSL
- [ ] Plugin system
- [ ] VS Code extension

---

## Design Decisions & Rationale

| Decision | Rationale |
|----------|-----------|
| JSONL over JSON | Append-only, streaming-friendly, grep-able, easy to tail |
| YAML over TOML for config | More readable for multi-line prompts (personas) |
| MCP over custom tool schema | Industry standard, interchangeable with other MCP clients |
| Event Bus + Bridge as separate layers | Different concerns: system observability vs agent coordination |
| Provider abstraction from day 1 | Much harder to retrofit; forces clean interfaces |
| Agent as first-class object | Enables CLI subcommands (`weave agent create`, `weave agent list`) |
| Persona as YAML files | Users can edit with any text editor, no DSL to learn |
| Gzip over custom compression | Ubiquitous, fast, lossless, known tooling |
