<p>
  <img src="https://raw.githubusercontent.com/nicobailon/pi-messenger/main/banner.png" alt="pi-messenger" width="1100">
</p>

# Pi Messenger — Orchestrator Fork

> **Fork of [nicobailon/pi-messenger](https://github.com/nicobailon/pi-messenger)** adding Orchestrator Mode: spawn, manage, and coordinate persistent worker agents with shared vector memory.

Upstream pi-messenger's Crew system runs ephemeral workers — one task, then exit. This fork adds a supervisor layer where an orchestrator agent spawns long-lived workers in tmux panes, assigns them tasks on the fly via DM, monitors their lifecycle, and builds up a shared memory of what's been done across sessions.

All orchestrator behavior is gated behind `isOrchestrator()` — only activates when you've spawned agents. Everything from upstream (mesh, crew, overlay) works identically. See the [upstream README](https://github.com/nicobailon/pi-messenger#readme) for those docs.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](LICENSE)
[![Upstream](https://img.shields.io/badge/Upstream-nicobailon%2Fpi--messenger-blue?style=for-the-badge)](https://github.com/nicobailon/pi-messenger)

---

## What's Different

| | Upstream Crew | Orchestrator Fork |
|---|---|---|
| **Workers** | Ephemeral — spawn for one task, exit | Persistent — spawn once, assign many tasks |
| **Task assignment** | Planner creates full task graph upfront | Ad-hoc — orchestrator assigns via DM on the fly |
| **Memory** | None across sessions | Vector memory (zvec/RocksDB) — recalled across spawns |
| **Lifecycle** | Managed by wave system | State machine: `spawning → joined → idle → assigned → done → dead` |
| **Spawn method** | Headless `child_process.spawn` only | tmux panes (attachable) with headless fallback |
| **Message budget** | 0–10 per worker (by coordination level) | 100 for orchestrator sessions |
| **Monitoring** | JSONL progress | Health checks, idle detection, orphan reaping, spawn diagnostics |

---

## Installation

```bash
git clone https://github.com/ishanmalik/pi-messenger-fork.git
cd pi-messenger-fork
npm install

# Register as a pi extension (from within any project)
pi install /path/to/pi-messenger-fork
```

---

## Quick Start

```typescript
// 1. Join mesh
pi_messenger({ action: "join" })

// 2. Spawn a worker (tmux pane by default)
pi_messenger({ action: "spawn", profile: "worker-xhigh", name: "Builder" })
// or: pi_messenger({ action: "spawn", model: "anthropic/claude-sonnet-4-6", name: "Builder", thinking: "high" })

// 3. Assign a task (memory auto-injected if enabled)
pi_messenger({ action: "agents.assign", name: "Builder", task: "Implement Redis caching", workstream: "backend" })

// 4. Communicate & monitor
pi_messenger({ action: "send", to: "Builder", message: "Use TTL-based invalidation" })
pi_messenger({ action: "agents.check", name: "Builder" })
pi_messenger({ action: "agents.logs", name: "Builder" })

// 5. Worker signals completion (auto-killed if configured, summary stored in memory)
// (called by the worker): pi_messenger({ action: "agents.done", summary: "Implemented Redis caching with 5-min TTL" })

// 6. Lifecycle
pi_messenger({ action: "agents.kill", name: "Builder" })
pi_messenger({ action: "agents.killall" })
pi_messenger({ action: "agents.attach", name: "Builder" })  // attach to tmux pane

// 7. Memory
pi_messenger({ action: "agents.memory.stats" })
pi_messenger({ action: "agents.memory.reset" })
```

---

## API Reference

| Action | Description |
|--------|-------------|
| `spawn` | Spawn a worker (`name` required; `profile`, `model`, `thinking`, `workstream` optional) |
| `agents.list` | List all spawned agents with lifecycle state |
| `agents.assign` | Assign a task (`name` + `task` required, `workstream` optional) |
| `agents.check` | Agent status + recent activity (`name` required) |
| `agents.logs` | Tail agent output (`name` required, `lines` optional, default 50) |
| `agents.attach` | Attach to tmux pane (`name` required) |
| `agents.done` | Worker reports completion (`summary` required) |
| `agents.kill` | Kill agent (`name` required) |
| `agents.killall` | Kill all spawned agents |
| `agents.memory.stats` | Vector memory statistics |
| `agents.memory.reset` | Wipe and reinitialize memory |

---

## Configuration

Add to `~/.pi/agent/pi-messenger.json` under the `crew` key:

```json
{
  "crew": {
    "orchestrator": {
      "defaultModel": "anthropic/claude-sonnet-4-6",
      "defaultThinking": "high",
      "maxSpawnedAgents": 5,
      "messageBudget": 100,
      "autoKillOnDone": true,
      "memory": {
        "enabled": true,
        "embeddingProvider": "google",
        "embeddingModel": "gemini-embedding-001"
      }
    }
  }
}
```

| Setting | Description | Default |
|---------|-------------|---------|
| `defaultModel` | Model for spawned workers | `anthropic/claude-sonnet-4-6` |
| `defaultThinking` | Default thinking level | `high` |
| `maxSpawnedAgents` | Max concurrent agents | `5` |
| `spawnTimeoutMs` | Base spawn timeout | `30000` (30s) |
| `spawnTimeoutMaxMs` | Max timeout after multipliers | `180000` (3min) |
| `spawnTimeoutSlowModelMultiplier` | Multiplier for large models (opus, gpt-5, o1, o3) | `1.75` |
| `spawnTimeoutHighThinkingMultiplier` | Multiplier for high/xhigh thinking | `1.5` |
| `idleTimeoutMs` | Warn after agent idle this long | `300000` (5min) |
| `autoKillOnDone` | Auto-terminate after `agents.done` | `true` |
| `gracePeriodMs` | Grace period before SIGTERM | `15000` (15s) |
| `messageBudget` | Max outgoing messages for orchestrator | `100` |
| `memory.enabled` | Enable vector memory | `true` |
| `memory.embeddingProvider` | `"google"` or `"openai"` | `google` |
| `memory.embeddingModel` | Embedding model name | `gemini-embedding-001` |
| `memory.dimensions` | Vector dimensions | `1536` |
| `memory.maxEntries` | Max entries in store | `10000` |
| `memory.autoInjectTopK` | Top-K recalled on assignment | `3` |
| `memory.minSimilarity` | Min cosine similarity for recall | `0.3` |
| `memory.ttlDays` | Per-type TTL: `message: 7`, `discovery: 30`, `summary: 90`, `decision: 90` | (see defaults) |

For Gemini embeddings, set `GEMINI_API_KEY` via env var, `.env.local`, or `secrets/local.env`. For OpenAI, set `OPENAI_API_KEY`.

---

## Architecture

```
┌──────────────────────────────────────────────────────┐
│  Orchestrator (your pi session)                      │
│                                                      │
│  crew/index.ts ─→ handlers/orchestrator.ts           │
│       │              │           │          │        │
│       │         registry.ts  memory.ts  embedding.ts │
│       │         (lifecycle)  (zvec/DB)  (API client) │
│       │                                              │
│  spawn ──→ tmux new-window / child_process.spawn     │
│       │                                              │
│  ┌────▼─────┐  ┌──────────┐  ┌──────────┐          │
│  │ Worker A │  │ Worker B │  │ Worker C │          │
│  │ (tmux)   │  │ (tmux)   │  │(headless)│          │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘          │
│       └──── messenger DMs (file-based inbox) ───┘    │
└──────────────────────────────────────────────────────┘
                       │
        .pi/messenger/orchestrator/
        ├── agents/*.json       ← spawned agent state
        ├── history.jsonl       ← event log
        ├── memory/ (zvec/rocks)← vector embeddings
        └── spawn-diagnostics/  ← timeout debug dumps
```

### Lifecycle State Machine

```
spawning ──→ joined ──→ idle ⇄ assigned ──→ done ──→ dead
                         │         │          │
                        dead      dead       dead
```

### Vector Memory

- **Storage**: [zvec](https://github.com/nicobailon/zvec) (RocksDB-backed) at `.pi/messenger/orchestrator/memory/`
- **Write**: on `agents.done` — summary embedded and stored
- **Read**: on `agents.assign` — top-K relevant summaries recalled and injected as context
- **Isolation**: `workstream` tags scope recall to a namespace
- **Resilience**: circuit breaker (3 failures → 60s cooldown), corruption auto-heal (backup + reinit), TTL expiration

### Health & Monitoring

Runs on the existing status heartbeat (only when `isOrchestrator()` is true):
- **Health checks** — verifies PIDs, reaps dead agents
- **Idle detection** — warns when agents exceed timeout with no activity
- **Orphan reaping** — cleans up agents from crashed sessions on startup
- **Spawn diagnostics** — on timeout, dumps PID snapshots, tmux output, mesh state

### Overlay Integration

The `/messenger` overlay agents row shows orchestrator-managed agents with lifecycle labels (`[assigned]`, `[idle]`). Agents not yet in the mesh appear with 🧭.

---

## Credits

- **[nicobailon/pi-messenger](https://github.com/nicobailon/pi-messenger)** — upstream (mesh, crew, overlay)
- **[Pi coding agent](https://github.com/badlogic/pi-mono/)** by [@badlogicgames](https://x.com/badlogicgames)

## License

MIT
