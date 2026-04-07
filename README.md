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

Crew agents ship with the extension (`crew/agents/*.md`) and are discovered automatically. The `pi-messenger-crew` skill is auto-loaded from the extension. Workers can load domain-specific [crew skills](#crew-skills) on demand during task execution.

To show available crew agents:

```bash
npx pi-messenger --crew-install
```

To customize an agent for one project, copy it to `.pi/messenger/crew/agents/` and edit it.

To remove the extension:

```bash
npx pi-messenger --remove
```

To remove stale crew agent copies from the shared legacy directory (`~/.pi/agent/agents/`):

```bash
npx pi-messenger --crew-uninstall
```

---

## Quick Start

```typescript
// 1. Join mesh
pi_messenger({ action: "join" })

// 2. Core mesh coordination
pi_messenger({ action: "reserve", paths: ["src/auth/"], reason: "Refactoring" })
pi_messenger({ action: "send", to: "GoldFalcon", message: "auth is done" })
pi_messenger({ action: "release" })

// 3. Spawn a worker (tmux pane by default)
pi_messenger({ action: "spawn", profile: "worker-xhigh", name: "Builder" })
// or: pi_messenger({ action: "spawn", model: "anthropic/claude-sonnet-4-6", name: "Builder", thinking: "high" })

// 4. Assign a task (memory auto-injected if enabled)
pi_messenger({ action: "agents.assign", name: "Builder", task: "Implement Redis caching", workstream: "backend" })

// 5. Communicate & monitor
pi_messenger({ action: "send", to: "Builder", message: "Use TTL-based invalidation" })
pi_messenger({ action: "agents.check", name: "Builder" })
pi_messenger({ action: "agents.logs", name: "Builder" })

// 6. Worker signals completion (auto-killed if configured, summary stored in memory)
// (called by the worker): pi_messenger({ action: "agents.done", summary: "Implemented Redis caching with 5-min TTL" })

// 7. Lifecycle
pi_messenger({ action: "agents.kill", name: "Builder" })
pi_messenger({ action: "agents.killall" })
pi_messenger({ action: "agents.attach", name: "Builder" })  // attach to tmux pane

// 8. Memory
pi_messenger({ action: "agents.memory.stats" })
pi_messenger({ action: "agents.memory.reset" })

// 9. Leave mesh when done
pi_messenger({ action: "leave" })
```

For multi-agent task orchestration from a PRD:

```typescript
pi_messenger({ action: "plan" })                       // Planner analyzes codebase, creates tasks
pi_messenger({ action: "work", autonomous: true })      // Workers execute tasks in waves until done
pi_messenger({ action: "review", target: "task-1" })    // Reviewer checks implementation
```

## Features

**Living Presence** - Status indicators (active, idle, away, stuck), tool call counts, token usage, and auto-generated status messages like "on fire" or "debugging...". Your agent name appears in the status bar: `msg: SwiftRaven (2 peers) ●3`

**Activity Feed** - Unified timeline of edits, commits, test runs, messages, and task events. Query with `{ action: "feed" }`.

**Discovery** - Agents register with memorable themed names (SwiftRaven, LunarDust, OakTree). See who's active, what they're working on, which model and git branch they're on.

**Messaging** - Send messages between agents. Recipients wake up immediately and see the message as a steering prompt.

**File Reservations** - Claim files or directories. Other agents get blocked with a clear message telling them who to coordinate with. Auto-releases on `leave` or exit.

**Stuck Detection** - Agents idle too long with an open task or reservation are flagged as stuck. Peers get a notification.

**Human as Participant** - Your interactive pi session appears in the agent list with `(you)`. Same activity tracking, same status messages. Chat from the overlay.

## Chat Overlay

`/messenger` opens an interactive overlay with agent presence, activity feed, and chat:

<img width="1198" height="1020" alt="pi-messenger crew overlay" src="https://github.com/user-attachments/assets/d66e5d71-5ed9-4702-9f56-9ca3f0e9c584" />

Chat input supports `@Name msg` for DMs and `@all msg` for broadcasts. Text without `@` broadcasts from the Agents tab or DMs the selected agent tab.

| Key | Action |
|-----|--------|
| `Tab` / `←` `→` | Switch tabs (Agents, Crew, agent DMs, All) |
| `↑` `↓` | Scroll history / navigate crew tasks |
| `Enter` | Send message |
| `Esc` | Close |

## Crew: Task Orchestration

Crew turns a PRD into a dependency graph of tasks, then executes them in parallel waves.

Crew logs are per project, under that project's working directory: `.pi/messenger/crew/`. For example, if you run Crew from `/path/to/my-app`, the planner log lives at `/path/to/my-app/.pi/messenger/crew/planning-progress.md`.

### Workflow

1. **Plan** — Planner explores the codebase and PRD, drafts tasks with dependencies. A reviewer checks the plan; the planner refines until SHIP or `maxPasses` is reached. History is stored in `planning-progress.md`.
2. **Work** — Workers implement ready tasks (all dependencies met) in parallel waves. A single `work` call runs one wave. `autonomous: true` runs waves back-to-back until everything is done or blocked. Each completed task gets an automatic reviewer pass — SHIP keeps it done, NEEDS_WORK resets it for retry with feedback, MAJOR_RETHINK blocks it. Controlled by `review.enabled` and `review.maxIterations`.
3. **Review** — Manual review of a specific task or the plan: `pi_messenger({ action: "review", target: "task-1" })`. Returns SHIP, NEEDS_WORK, or MAJOR_RETHINK with detailed feedback.

No special PRD format required — the planner auto-discovers `PRD.md`, `SPEC.md`, `DESIGN.md`, etc. in your project root and `docs/`. Or skip the file entirely:

```typescript
pi_messenger({ action: "plan", prompt: "Scan the codebase for bugs" })

// Plan + auto-start autonomous work when planning completes
pi_messenger({ action: "plan" })  // auto-starts workers (default)
```

### Wave Execution

Tasks form a dependency graph. Independent tasks run concurrently:

```
Wave 1:  task-1 (no deps)  ─┐
         task-3 (no deps)  ─┤── run in parallel
                             │
Wave 2:  task-2 (→ task-1) ─┤── task-1 done, task-2 unblocked
         task-4 (→ task-3) ─┘── task-3 done, task-4 unblocked

Wave 3:  task-5 (→ task-2, task-4) ── both deps done
```

The planner structures tasks to maximize parallelism. Foundation work has no dependencies and starts immediately. Features that don't touch each other get separate chains. Autonomous mode stops when all tasks are done or blocked.

### Crew Skills

Workers follow the same join/read/implement/commit/release protocol regardless of the task — what changes between tasks is domain knowledge. Crew skills let workers acquire that knowledge on demand.

Skills are discovered from three locations (later sources override earlier by name):

1. **User skills** — `~/.pi/agent/skills/` (pi's standard `dir/SKILL.md` format)
2. **Extension skills** — `crew/skills/` within the extension (flat `.md` files)
3. **Project skills** — `.pi/messenger/crew/skills/` in your project root (flat `.md` files)

The planner sees a compact index of all discovered skills and can tag tasks with relevant ones. Workers see tagged skills as "Recommended for this task" with the full catalog under "Also available", and load what they need via `read()`. Zero tokens spent until a worker actually needs the knowledge.

To add a project-level skill, drop a `.md` file in `.pi/messenger/crew/skills/`:

```markdown
---
name: our-api-patterns
description: REST API conventions for this project — auth, pagination, error shapes.
---

# API Patterns

Always use Bearer token auth. Paginate with cursor-based `?after=` params.
Error responses use `{ error: { code, message, details? } }` shape.
```

Any skills you already have in `~/.pi/agent/skills/` are automatically available to crew workers — no setup needed.

### Crew Configuration

Crew spawns multiple LLM sessions in parallel — it can burn tokens fast. Start with a cheap worker model and scale up once you've seen the workflow. Add this to `~/.pi/agent/pi-messenger.json`:

```json
{ "crew": { "models": { "worker": "claude-haiku-4-5" } } }
```

The planner and reviewer keep their frontmatter defaults; only workers (the bulk of the spend) get the cheap model. Override per-role as needed:

```json
{
  "crew": {
    "models": {
      "worker": "claude-haiku-4-5",
      "planner": "claude-sonnet-4-6",
      "reviewer": "claude-sonnet-4-6"
    }
  }
}
```

Model strings accept `provider/model` format for explicit provider selection and `:level` suffix for inline thinking control. These work anywhere a model is specified — config, frontmatter, or per-task override:

```json
{
  "crew": {
    "models": {
      "worker": "anthropic/claude-haiku-4-5",
      "planner": "openrouter/anthropic/claude-sonnet-4:high"
    }
  }
}
```

The `:level` suffix and the `thinking.<role>` config are independent — if both are set, the suffix takes precedence and the `--thinking` flag is skipped to avoid double-application.

Full config reference (all fields optional — only set what you want to change):

```json
{
  "crew": {
    "concurrency": { "workers": 2, "max": 10 },
    "coordination": "chatty",
    "models": { "worker": "claude-haiku-4-5" },
    "review": { "enabled": true, "maxIterations": 3 },
    "planning": { "maxPasses": 1 },
    "work": {
      "maxAttemptsPerTask": 5,
      "maxWaves": 50
    }
  }
}
```

| Setting | Description | Default |
|---------|-------------|---------|
| `concurrency.workers` | Default parallel workers per wave | `2` |
| `concurrency.max` | Maximum workers allowed (hard ceiling is 10) | `10` |
| `dependencies` | Dependency scheduling mode: `advisory` or `strict` | `"advisory"` |
| `coordination` | Worker coordination level: `none`, `minimal`, `moderate`, `chatty` | `"chatty"` |
| `messageBudgets` | Max outgoing messages per worker per level (sends rejected after limit) | `{ none: 0, minimal: 2, moderate: 5, chatty: 10 }` |
| `models.planner` | Model for planner agent | `anthropic/claude-opus-4-6` |
| `models.worker` | Model for workers (overridden by per-task or per-wave `model` param) | `anthropic/claude-haiku-4-5` |
| `models.reviewer` | Model for reviewer agent | `anthropic/claude-opus-4-6` |
| `models.analyst` | Model for analyst (plan-sync) agent | `anthropic/claude-haiku-4-5` |
| `thinking.planner` | Thinking level for planner agent | (from frontmatter) |
| `thinking.worker` | Thinking level for worker agents | (from frontmatter) |
| `thinking.reviewer` | Thinking level for reviewer agents | (from frontmatter) |
| `thinking.analyst` | Thinking level for analyst agents | (from frontmatter) |
| `review.enabled` | Auto-review after task completion | `true` |
| `review.maxIterations` | Max review/fix cycles per task | `3` |
| `planning.maxPasses` | Max planner/reviewer refinement passes | `1` |
| `work.maxAttemptsPerTask` | Auto-block after N failures | `5` |
| `work.maxWaves` | Max autonomous waves | `50` |
| `work.shutdownGracePeriodMs` | Grace period before SIGTERM on abort | `30000` |
| `work.env` | Environment variables passed to spawned workers | `{}` |

### Default Agent Models

Each crew agent ships with a default model in its frontmatter. Override any of these via `crew.models.<role>` in config:

| Agent | Role | Default Model |
|-------|------|---------------|
| `crew-planner` | planner | `anthropic/claude-opus-4-6` |
| `crew-worker` | worker | `anthropic/claude-haiku-4-5` |
| `crew-reviewer` | reviewer | `anthropic/claude-opus-4-6` |
| `crew-plan-sync` | analyst | `anthropic/claude-haiku-4-5` |

Agent definitions live in `crew/agents/` within the extension. To customize one for a project, copy it to `.pi/messenger/crew/agents/` and edit the frontmatter — project-level agents override extension defaults by name. Agents support `thinking: <level>` in frontmatter (off, minimal, low, medium, high, xhigh). Config `thinking.<role>` overrides the frontmatter value.

---

## API Reference

| Action | Description |
|--------|-------------|
| `join` | Join the agent mesh |
| `leave` | Leave the mesh for the current session |
| `list` | List agents with presence info |
| `status` | Show your status or crew progress |
| `whois` | Detailed info about an agent (`name` required) |
| `feed` | Show activity feed (`limit` optional, default: 20) |
| `set_status` | Set custom status message (`message` optional — omit to clear) |
| `send` | Send DM (`to` + `message` required) |
| `broadcast` | Broadcast to all (`message` required) |
| `reserve` | Reserve files (`paths` required, `reason` optional) |
| `release` | Release reservations (`paths` optional — omit to release all) |
| `rename` | Change your name (`name` required) |
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
| `heartbeat.status` | Show heartbeat status |
| `heartbeat.pause` | Pause status heartbeat (no periodic refresh) |
| `heartbeat.resume` | Resume status heartbeat |
| `heartbeat.autopause` | Toggle auto-pause when idle |
| `data.session` | Set session tags (`project`, `runType`) for filtering/export |
| `data.stats` | Show data volume + training-eligible counts by category/project |
| `data.export` | Export training-ready JSONL corpus (filter by `project`, `minQualityScore`) |
| `data.retention` | Run retention/cleanup janitor now |

### Crew

| Action | Description |
|--------|-------------|
| `plan` | Create plan from PRD or inline prompt (`prd`, `prompt` optional — auto-discovers PRD if omitted, auto-starts workers unless `autoWork: false`) |
| `work` | Run ready tasks (`autonomous`, `concurrency` optional) |
| `work.stop` | Stop autonomous work for the current project |
| `review` | Review implementation (`target` task ID required) |
| `task.list` | List all tasks |
| `task.show` | Show task details (`id` required) |
| `task.start` | Start a task (`id` required) |
| `task.done` | Complete a task (`id` required, `summary` optional) |
| `task.block` | Block a task (`id` + `reason` required) |
| `task.unblock` | Unblock a task (`id` required) |
| `task.ready` | List tasks ready to work |
| `task.reset` | Reset a task (`id` required, `cascade` optional) |
| `crew.status` | Overall crew status |
| `crew.validate` | Validate plan dependencies |
| `crew.agents` | List available crew agents |
| `crew.install` | Show discovered crew agents and their sources |
| `crew.uninstall` | Remove stale shared-directory crew agent copies |

### Swarm (Spec-Based)

| Action | Description |
|--------|-------------|
| `swarm` | Show swarm task status |
| `claim` | Claim a task (`taskId` required) |
| `unclaim` | Release a claim (`taskId` required) |
| `complete` | Complete a task (`taskId` required) |

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
    },
    "dataPolicy": {
      "enabled": true,
      "strictProjectFilter": true,
      "defaultProject": "bergomi2",
      "allowedProjects": ["bergomi2"],
      "defaultCategory": "production_work",
      "defaultRunType": "production"
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
| `dataPolicy.enabled` | Enable strict keep/drop rules for captured data | `true` |
| `dataPolicy.strictProjectFilter` | Only allow configured project(s) into training exports | `true` |
| `dataPolicy.defaultProject` | Primary project label used when context is missing | `""` |
| `dataPolicy.allowedProjects` | Training export allowlist (empty = defaultProject only) | `[]` |
| `dataPolicy.defaultCategory` | Fallback category for uncategorized events | `production_work` |
| `dataPolicy.categories.production_work` | Full retention + training include policy | `{ storage: "full", training: "include", retentionDays: 3650 }` |
| `dataPolicy.categories.smoke_test` | Summarize only, exclude from training | `{ storage: "summary", training: "exclude", retentionDays: 14 }` |
| `dataPolicy.categories.off_topic` | Drop from retained corpus and training | `{ storage: "drop", training: "exclude", retentionDays: 3 }` |
| `dataPolicy.categories.ops_debug` | Keep summarized operational diagnostics | `{ storage: "summary", training: "exclude", retentionDays: 30 }` |
| `dataPolicy.ingestion.dedupeWindowMs` | De-duplicate repeated events within this window | `10000` |
| `dataPolicy.ingestion.summaryMaxChars` | Max chars for summary-only storage mode | `280` |
| `dataPolicy.classifier.enabled` | Enable second-pass heuristic classifier | `true` |
| `dataPolicy.progress.maxRawLines` | Progress log compaction threshold | `200` |
| `dataPolicy.progress.keepRecentLines` | Lines kept after progress compaction | `80` |
| `dataPolicy.retention.historyDays` | Retention for orchestrator history log | `30` |
| `dataPolicy.retention.diagnosticsDays` | Retention for spawn diagnostics dumps | `14` |
| `dataPolicy.retention.artifactsDays` | Retention for crew artifact files | `7` |
| `dataPolicy.export.format` | Training export format | `jsonl` |
| `dataPolicy.export.includeDroppedMetadata` | Include metadata-only dropped records in exports | `false` |

### Data policy categories (recommended)

- `production_work`: real implementation work for your target project; keep in full and include for training.
- `smoke_test`: probes, harness runs, temporary checks; keep only short summaries.
- `off_topic`: unrelated Q&A (e.g., framework tutorials outside project scope); drop from retained corpus.
- `ops_debug`: operational troubleshooting; keep summarized diagnostics for short retention.

### Messenger settings (top-level in `~/.pi/agent/pi-messenger.json`)

```json
{
  "heartbeatEnabled": true,
  "heartbeatIntervalMs": 15000,
  "heartbeatAutoPause": true
}
```

When `heartbeatAutoPause` is on, the heartbeat only runs while an overlay is open, planning is active, workers are running, or orchestrator agents exist.

All coordination is file-based, no daemon required. Shared state (registry, inboxes, swarm claims/completions) lives in `~/.pi/agent/messenger/`. Activity feed and crew data are project-scoped under `.pi/messenger/` inside your project, so Crew logs live at `<project>/.pi/messenger/crew/` and the shared activity feed lives at `<project>/.pi/messenger/feed.jsonl`. Dead agents are detected via PID checks and cleaned up automatically.

For Gemini embeddings, set `GEMINI_API_KEY` via env var, `.env.local`, or `secrets/local.env`. For OpenAI, set `OPENAI_API_KEY`.

> Note: `@zvec/zvec` currently ships native bindings for macOS arm64, Linux arm64, and Linux x64. On unsupported platforms, memory degrades gracefully and orchestrator features still work without vector recall.

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

## Credits

- **[nicobailon/pi-messenger](https://github.com/nicobailon/pi-messenger)** — upstream (mesh, crew, overlay)
- **[Pi coding agent](https://github.com/badlogic/pi-mono/)** by [@badlogicgames](https://x.com/badlogicgames)

## License

MIT
