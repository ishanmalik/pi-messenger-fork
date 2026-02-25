# Orchestrator Mode for pi-messenger — Full Implementation Spec

## Overview

This spec describes adding **Orchestrator Mode** to [pi-messenger](https://github.com/nicobailon/pi-messenger), a Node.js/TypeScript extension for the [pi coding agent](https://pi.dev/). The feature enables a pi agent to spawn persistent worker agents, assign them tasks via DM, monitor them, inject shared memory context, and kill them when done.

This is a **public fork** of the upstream project. The fork lives at `~/repos/pi-messenger-fork/`. Changes go on a feature branch (`feature/orchestrator-mode`). The upstream npm package (`npm:pi-messenger`) remains untouched.

---

## Table of Contents

1. [Background: How pi-messenger Works Today](#background-how-pi-messenger-works-today)
2. [What We're Building](#what-were-building)
3. [Architecture Decisions](#architecture-decisions)
4. [Setup Steps (Phase 1)](#phase-1-fork--setup-steps-15)
5. [Foundation — State, Config, Memory (Phase 2)](#phase-2-foundation--state-config-memory-steps-68)
6. [Core Spawn & Kill (Phase 3)](#phase-3-core-spawn--kill-steps-914)
7. [Routing & Schema (Phase 4)](#phase-4-routing--schema-steps-1516)
8. [Enhanced Messaging & Assignment (Phase 5)](#phase-5-enhanced-messaging--assignment-steps-1719)
9. [Monitoring & Cleanup (Phase 6)](#phase-6-monitoring--cleanup-steps-2023)
10. [Overlay, Skill & Polish (Phase 7)](#phase-7-overlay-skill--polish-steps-2428)
11. [File Map — What Goes Where](#file-map--what-goes-where)
12. [Reviewed Failure Modes & Mitigations](#reviewed-failure-modes--mitigations)
13. [Testing Checklist](#testing-checklist)
14. [Kickoff Prompt](#kickoff-prompt)

---

## Background: How pi-messenger Works Today

### Architecture

pi-messenger is a pi extension (Node.js/TypeScript, MIT license). It enables multiple pi agent instances across terminals to coordinate via a **file-based mesh** — no daemon, no server.

**Key files & directories:**

```
~/.pi/agent/messenger/           # Global (shared across all projects)
├── registry/                    # Agent registry — one JSON file per agent
│   ├── SwiftRaven.json          # { name, pid, cwd, model, gitBranch, session, activity, reservations, ... }
│   └── LunarDust.json
└── inbox/                       # Message delivery — one dir per agent
    ├── SwiftRaven/              # Messages TO SwiftRaven
    │   └── 1708234567-abc123.json  # { id, from, to, text, timestamp, replyTo }
    └── LunarDust/

<project>/.pi/messenger/         # Project-scoped
├── feed.jsonl                   # Activity feed (edits, commits, messages, task events)
└── crew/                        # Crew task orchestration
    ├── config.json              # Project-level crew config
    ├── plan.json                # Plan metadata
    ├── planning-progress.md     # Planner output log
    ├── tasks/                   # Task files (task-N.json, task-N.md, task-N.progress.md)
    └── agents/                  # Project-level agent overrides
```

### Message Delivery Flow

1. Sender writes a JSON file to `~/.pi/agent/messenger/inbox/<recipientName>/`
2. Recipient's `fs.watch()` on their inbox directory detects the new file
3. Extension calls `pi.sendMessage()` with `{ triggerTurn: true, deliverAs: "steer" }`
4. This injects the message as a **steering prompt** that wakes the agent and triggers a new turn
5. The message file is consumed (deleted after delivery)

### Crew Workers (existing)

Crew already spawns worker agents as subprocesses:
- Spawned via `child_process.spawn("pi", ["--mode", "json", "--no-session", "-p", ...])` — **headless**, exit after one task
- Workers get `PI_AGENT_NAME` and `PI_CREW_WORKER=1` env vars
- Worker stdout is parsed as JSONL for progress tracking
- Lobby workers are a variant: spawn idle, wait for task assignment via DM, then work and exit
- Graceful shutdown: inbox message → grace period → SIGTERM → SIGKILL

### Key Source Files in the Extension

All paths relative to the extension root (installed at `~/.nvm/versions/node/v25.6.1/lib/node_modules/pi-messenger/` or your local clone):

| File | Purpose |
|------|---------|
| `index.ts` | Main extension entry — registers tool, commands, hooks (`session_start`, `tool_call`, `tool_result`, `turn_end`, `agent_end`, `session_shutdown`) |
| `handlers.ts` | Tool execute functions for coordination actions (join, send, reserve, list, feed, etc.) |
| `lib.ts` | Shared types, helpers, status computation |
| `store.ts` | Registry read/write, inbox watcher, message sending, reservation checks |
| `config.ts` | Config loading (`~/.pi/agent/pi-messenger.json` + project `.pi/pi-messenger.json`) |
| `feed.ts` | Activity feed read/write/prune |
| `overlay.ts` | `/messenger` overlay UI |
| `overlay-render.ts` | Overlay rendering logic |
| `overlay-actions.ts` | Overlay keybinding handlers |
| `crew/index.ts` | Crew action router — dispatches `plan`, `work`, `task.*`, `review`, `crew.*` |
| `crew/agents.ts` | Agent spawning with progress tracking, shutdown, JSONL parsing |
| `crew/lobby.ts` | Lobby worker spawning, assignment, keep-alive, shutdown |
| `crew/spawn.ts` | Higher-level spawn helpers (spawnWorkersForReadyTasks, spawnSingleWorker) |
| `crew/prompt.ts` | Worker prompt construction |
| `crew/store.ts` | Crew-specific state (tasks, plan, progress files) |
| `crew/state.ts` | Planning/autonomous state management |
| `crew/types.ts` | Crew type definitions |
| `crew/handlers/work.ts` | Work handler — spawns workers for ready tasks |
| `crew/handlers/plan.ts` | Plan handler — spawns planner agent |
| `crew/handlers/task.ts` | Task CRUD handlers |
| `crew/handlers/review.ts` | Review handler |
| `crew/handlers/status.ts` | Crew status handlers |
| `crew/utils/config.ts` | Crew config loading, `CrewConfig` type, `deepMerge`, defaults |
| `crew/utils/discover.ts` | Crew agent discovery (finds agent .md files) |
| `crew/utils/progress.ts` | JSONL progress parsing |
| `crew/registry.ts` | In-process worker registry (tracks spawned child processes) |
| `crew/live-progress.ts` | Live worker progress tracking for overlay |
| `skills/pi-messenger-crew/SKILL.md` | Crew skill file (auto-loaded) |

### Message Budget System

Workers have a per-session message limit based on coordination level:
- `none: 0`, `minimal: 2`, `moderate: 5`, `chatty: 10`
- Tracked by module-level `messagesSentThisSession` counter in `handlers.ts`
- Budget check in `executeSend()` — rejects messages over limit

### Config Loading Priority

```
defaults ← user (~/.pi/agent/pi-messenger.json → crew key) ← project (.pi/messenger/crew/config.json)
```

Uses `deepMerge()` in `crew/utils/config.ts`.

### Extension API Hooks Used

```typescript
pi.registerTool({ name: "pi_messenger", ... })     // The main tool
pi.registerCommand("messenger", ...)                 // /messenger overlay
pi.on("session_start", ...)                          // Auto-register, restore state
pi.on("session_shutdown", ...)                       // Cleanup, unregister
pi.on("tool_call", ...)                              // Activity tracking, reservation enforcement
pi.on("tool_result", ...)                            // Activity tracking
pi.on("turn_end", ...)                               // Process pending messages, status update
pi.on("agent_end", ...)                              // Autonomous work continuation
pi.sendMessage({ triggerTurn, deliverAs })            // Message injection
pi.appendEntry(type, data)                           // Session state persistence
```

---

## What We're Building

### Core Feature: Orchestrator Mode

An orchestrator agent (running in an interactive pi session) can:

1. **Spawn** persistent worker agents in tmux panes (or headless as fallback)
2. **Assign** tasks to spawned agents via structured DMs with memory context
3. **Message** agents freely for ongoing guidance (elevated message budget)
4. **Monitor** agent health, status, and activity via registry + mesh cross-reference
5. **Kill** agents gracefully when done (DM → SIGTERM → SIGKILL → tmux cleanup)
6. **Remember** — a zvec-backed vector memory store persists agent work summaries across kills/respawns

### How It Differs from Crew

| Aspect | Crew | Orchestrator Mode |
|--------|------|-------------------|
| Worker lifecycle | Headless, exit after task | Persistent, survives across tasks |
| Spawn mode | `pi --mode json -p` (child_process) | Interactive pi in tmux (or headless fallback) |
| Communication | Structured task assignment | Freeform DMs back and forth |
| Orchestration | Automated waves | Human/agent-directed |
| Memory | None | Zvec vector DB for cross-agent context |
| Visibility | JSONL progress stream | tmux pane (can attach/inspect) |

### Proof of Concept (Already Validated)

We ran a successful experiment:
1. Spawned a pi agent (claude-haiku-4-5) in a tmux pane with an initial prompt
2. Both agents joined the messenger mesh
3. They collaborated by taking turns writing words to an MD file via DMs
4. Each DM triggered a full agent turn via `triggerTurn: true`
5. The agent persisted across 4+ round trips without a human in its pane
6. Full audit trail captured in the activity feed

---

## Architecture Decisions

### 1. Interactive mode, not headless (for tmux path)

Spawned agents run as full interactive pi sessions. DMs act as user input via `triggerTurn: true`. This means:
- Agent persists indefinitely (doesn't exit after one task)
- Each DM triggers a full turn with tool access
- Context accumulates across messages (pro: continuity; con: eventual context bloat)

### 2. tmux primary, headless fallback

**Primary:** `tmux new-window` gives agents visible panes for debugging/inspection. Human can `tmux select-window` to peek at any agent.

**Fallback:** If tmux is unavailable (CI, headless server), fall back to `child_process.spawn()` with JSONL tracking, reusing patterns from `crew/lobby.ts`.

### 3. Per-agent file sharding (not single JSON)

Orchestrator registry uses one file per agent at `.pi/messenger/orchestrator/agents/<name>.json`, matching the pattern used by the mesh registry. Atomic writes via temp+rename. Avoids single-file race conditions.

### 4. Explicit lifecycle state machine

Every spawned agent has a state: `spawning → joined → idle → assigned → done → dead`. All actions validate state transitions. Invalid transitions return errors.

### 5. zvec for shared memory

In-process vector DB — no server, persists to disk, sub-ms search. Embedding via provider API (OpenAI `text-embedding-3-small` or equivalent). Memory is an enhancement — if zvec fails or is disabled, orchestration works without it.

### 6. Fork strategy

We fork `nicobailon/pi-messenger` to a public GitHub repo. Changes go on `feature/orchestrator-mode` branch. Upstream updates can be cherry-picked. Pi loads our fork via local path in `~/.pi/agent/settings.json`.

---

## Phase 1: Fork & Setup (Steps 1–5)

### Step 1: Fork on GitHub

- Go to `https://github.com/nicobailon/pi-messenger`
- Fork to user's GitHub account (public fork)
- This is a **manual browser step** — cannot be automated

### Step 2: Clone the fork

```bash
cd ~/repos
git clone git@github.com:<YOUR_GITHUB_USERNAME>/pi-messenger.git pi-messenger-fork
cd pi-messenger-fork
```

**Important:** If the user has already forked and cloned, skip this step. The clone target is `~/repos/pi-messenger-fork/`.

### Step 3: Install dependencies & build

```bash
cd ~/repos/pi-messenger-fork
npm install
npm run build  # Check package.json for actual build script name
```

This is a pure Node.js/TypeScript project. No Python, no conda. Uses the system Node.js via nvm (`/home/ishan/.nvm/versions/node/v25.6.1/`).

Also install zvec:
```bash
npm install @zvec/zvec
```

Verify zvec works on the platform:
```bash
node -e "const zvec = require('@zvec/zvec'); console.log('zvec loaded:', typeof zvec)"
```

### Step 4: Switch pi to load the local fork

Edit `~/.pi/agent/settings.json`:

Find: `"npm:pi-messenger"` in the extensions array
Replace with: `"/home/ishan/repos/pi-messenger-fork"`

Restart pi and verify:
- `pi_messenger` tool is available
- `/messenger` command works
- All existing functionality intact

### Step 5: Feature branch

```bash
cd ~/repos/pi-messenger-fork
git checkout -b feature/orchestrator-mode
```

All implementation work goes on this branch.

---

## Phase 2: Foundation — State, Config, Memory (Steps 6–8)

### Step 6: Orchestrator State Storage

**Create:** `crew/orchestrator/registry.ts`

#### Lifecycle State Machine

```
spawning ──→ joined ──→ idle ──→ assigned ──→ done ──→ dead
    │            │         │         │                    ▲
    │            │         │         └── (kill) ──────────┤
    │            │         └──── (kill) ─────────────────┤
    │            └────────── (kill) ─────────────────────┤
    └─────────── (timeout/fail) ────────────────────────┘
```

Valid transitions:
- `spawning → joined` (mesh registry confirms agent appeared)
- `spawning → dead` (spawn timeout — agent didn't join within 30s)
- `joined → idle` (automatic after join confirmation)
- `idle → assigned` (task assigned via `agents.assign`)
- `assigned → idle` (task completed via `agents.done`)
- `assigned → done` (task completed + autoKillOnDone)
- `idle → done` (explicitly killed while idle)
- `assigned → done` (explicitly killed while assigned)
- `done → dead` (cleanup completed)
- `* → dead` (PID died unexpectedly — detected by health monitor)

#### Per-Agent File Storage

Location: `.pi/messenger/orchestrator/agents/<name>.json`

Schema:
```typescript
interface SpawnedAgent {
  name: string;
  pid: number;
  sessionId: string;          // From mesh registry after join
  tmuxPaneId: string | null;  // null for headless fallback
  tmuxWindowId: string | null;
  model: string;
  thinking: string | undefined;
  status: "spawning" | "joined" | "idle" | "assigned" | "done" | "dead";
  spawnedAt: number;          // epoch ms
  spawnedBy: string;          // orchestrator agent name
  assignedTask: string | null;
  lastActivityAt: number;     // epoch ms, updated from mesh registry
  backend: "tmux" | "headless";
}
```

Atomic writes: write to `<name>.json.tmp`, then `fs.renameSync()` to `<name>.json`.

#### History Log

Location: `.pi/messenger/orchestrator/history.jsonl`

Each line: `{ event: "spawn"|"kill"|"assign"|"done"|"reap", agent, timestamp, details }`

#### Helper Functions

```typescript
export function registerSpawned(agent: SpawnedAgent): void;
export function unregisterSpawned(name: string): void;
export function getSpawned(name: string): SpawnedAgent | null;
export function getAllSpawned(): SpawnedAgent[];
export function transitionState(name: string, to: SpawnedAgentStatus): boolean; // returns false if invalid transition
export function isOrchestrator(): boolean; // true if this process has spawned agents
export function reapOrphans(): string[]; // returns names of reaped agents
export function logHistory(event: HistoryEvent): void;
```

#### Orphan Reaping (`reapOrphans`)

Called on `session_start`:
1. Read all agent files from `.pi/messenger/orchestrator/agents/`
2. For each entry not in `dead` state:
   - Check PID liveness: `process.kill(pid, 0)` wrapped in try/catch
   - Cross-reference: verify mesh registry has matching `{name, pid}` tuple
   - If PID dead or mesh entry missing: transition to `dead`, clean up tmux pane if exists, delete agent file
3. Return list of reaped agent names (for logging)

---

### Step 7: Orchestrator Config

**Modify:** `crew/utils/config.ts`

Add to `CrewConfig` interface:

```typescript
orchestrator: {
  defaultModel: string;
  defaultThinking: string;
  idleTimeoutMs: number;
  autoKillOnDone: boolean;
  gracePeriodMs: number;
  maxSpawnedAgents: number;
  spawnTimeoutMs: number;
  messageBudget: number;
  memory: {
    enabled: boolean;
    embeddingModel: string;
    embeddingProvider: string;
    dimensions: number;
    maxEntries: number;
    autoInjectTopK: number;
    minSimilarity: number;
    maxInjectionTokens: number;
    embeddingTimeoutMs: number;
    ttlDays: {
      message: number;
      discovery: number;
      summary: number;
      decision: number;
    };
  };
};
```

Add defaults to `DEFAULT_CONFIG`:

```typescript
orchestrator: {
  defaultModel: "anthropic/claude-sonnet-4-6",
  defaultThinking: "high",
  idleTimeoutMs: 300000,       // 5 minutes
  autoKillOnDone: true,
  gracePeriodMs: 15000,        // 15 seconds
  maxSpawnedAgents: 5,
  spawnTimeoutMs: 30000,       // 30 seconds
  messageBudget: 100,          // effectively unlimited for practical sessions
  memory: {
    enabled: true,
    embeddingModel: "text-embedding-3-small",
    embeddingProvider: "openai",
    dimensions: 1536,
    maxEntries: 10000,
    autoInjectTopK: 3,
    minSimilarity: 0.3,
    maxInjectionTokens: 2000,
    embeddingTimeoutMs: 2000,
    ttlDays: {
      message: 7,
      discovery: 30,
      summary: 90,
      decision: 90,
    },
  },
},
```

---

### Step 8: Shared Agent Memory Store (zvec)

**Create:** `crew/orchestrator/memory.ts`

**Dependency:** `@zvec/zvec` (npm package, v0.2.0+)

#### Collection Schema

```typescript
const SCHEMA = {
  name: "orchestrator_memory",
  vectors: { embedding: { type: "FP32", dimensions: config.dimensions } },
  fields: {
    agent: "string",
    type: "string",          // "summary" | "message" | "decision" | "discovery"
    source: "string",        // "agents.done" | "agents.kill" | "manual"
    timestamp: "string",     // ISO 8601
    createdAtMs: "number",   // epoch ms
    taskId: "string",
    files: "string",         // JSON-encoded string array
    contentHash: "string",   // SHA-256 of text content
    schemaVersion: "number", // 1
    embeddingModel: "string",
    embeddingDimensions: "number",
  }
};
```

#### Core Functions

```typescript
// Initialization
export async function initMemory(projectDir: string, config: MemoryConfig): Promise<MemoryStore>;
// - Opens or creates zvec collection at <projectDir>/.pi/messenger/orchestrator/memory/
// - On open: checks schemaVersion and embeddingDimensions match config
//   - If mismatch: throw error with clear message (user must run agents.memory.reset)
// - Runs startup health check: insert dummy → query → delete
//   - If fails: return degraded MemoryStore that logs warnings but doesn't crash
// - Prunes expired entries (TTL check)
// - Returns MemoryStore handle

// Write
export async function remember(
  store: MemoryStore,
  text: string,
  metadata: { agent: string; type: MemoryType; source: string; taskId?: string; files?: string[] }
): Promise<{ ok: boolean; degraded?: boolean; error?: string }>;
// - Compute contentHash(text) — skip if hash already exists (dedupe)
// - Call embedding API with timeout (embeddingTimeoutMs)
//   - On failure: increment failure counter, trip circuit breaker after 3 consecutive failures
//   - Circuit breaker: skip embedding for 60s, return { ok: false, degraded: true }
// - Insert into zvec collection
// - Check maxEntries — if exceeded, evict oldest low-importance entries
//   - Importance: summary > decision > discovery > message
//   - Within same importance: oldest first
//   - Respect per-agent fair share (no single agent > 40% of entries)

// Read
export async function recall(
  store: MemoryStore,
  query: string,
  options?: { topk?: number; minSimilarity?: number; maxTokens?: number; agentFilter?: string; typeFilter?: MemoryType[] }
): Promise<{ results: MemoryEntry[]; degraded?: boolean }>;
// - Call embedding API for query vector (with timeout)
// - Search zvec with topk
// - Filter results below minSimilarity threshold
// - Sort by relevance (similarity score * recency bonus)
// - Truncate to maxTokens (drop lowest-relevance entries until under budget)
// - Return results

// Cleanup
export function forgetAgent(store: MemoryStore, agentName: string): number; // returns count deleted
export function pruneExpired(store: MemoryStore, ttlDays: TtlConfig): number; // returns count pruned
export function getMemoryStats(store: MemoryStore): MemoryStats;
export function resetMemory(projectDir: string): void; // delete entire collection, start fresh
export function closeMemory(store: MemoryStore): void;

// Circuit breaker (internal)
// - Track consecutive embedding failures
// - After 3 failures: trip breaker (skip embeds for 60s)
// - On successful embed: reset counter
// - Expose breaker state in MemoryStats
```

#### Embedding API Integration

```typescript
// crew/orchestrator/embedding.ts

export async function embed(
  text: string,
  config: { provider: string; model: string; dimensions: number; timeoutMs: number }
): Promise<{ vector: number[]; ok: boolean; error?: string }>;
// - Determine API endpoint from provider:
//   - "openai" → https://api.openai.com/v1/embeddings
//   - Other providers: extend as needed
// - Use API key from environment (OPENAI_API_KEY, etc.)
// - POST with timeout (AbortController)
// - Return normalized vector
// - On error: return { vector: [], ok: false, error: message }
```

#### Memory Write Sources (canonical)

| Hook | Writes? | Type | Source |
|------|---------|------|--------|
| `agents.done` | ✅ Always | `summary` | `"agents.done"` |
| `agents.kill` (no prior done summary) | ✅ Fallback | `summary` | `"agents.kill"` |
| All other hooks | ❌ Read only | — | — |

#### Memory Read Sources

| Hook | Reads? | Purpose |
|------|--------|---------|
| `agents.assign` | ✅ | Search for relevant prior work, prepend to assignment DM |
| `spawn` (initial prompt) | ✅ Optional | Bootstrap context for new agent |

#### Storage Location

```
<project>/.pi/messenger/orchestrator/memory/    # zvec collection files
```

This directory should be in `.gitignore`.

---

## Phase 3: Core Spawn & Kill (Steps 9–14)

### Step 9: Implement `spawn` Action Handler

**Create:** `crew/handlers/orchestrator.ts`

This file contains all orchestrator action handlers.

#### `executeSpawn(params, state, dirs, ctx)`

Input: `{ action: "spawn", model?, name?, thinking?, prompt? }`

Flow:
1. **Check limits:** count `getAllSpawned()` — reject if ≥ `maxSpawnedAgents`
2. **Resolve model:** `params.model ?? config.orchestrator.defaultModel`
3. **Resolve thinking:** `params.thinking ?? config.orchestrator.defaultThinking`
4. **Resolve name:** `params.name ?? generateMemorableName()` (from `lib.ts`)
   - Collision check: verify name not in mesh registry AND not in orchestrator registry
   - Retry up to 5 times with new names if collision
5. **Clear stale inbox:** `rm -rf ~/.pi/agent/messenger/inbox/<name>/` then recreate empty dir
6. **Build initial prompt** (see Step 10 below)
7. **Detect backend:**
   - Check if tmux is available: try `tmux display-message -p '#{session_name}'`
   - If available: use tmux path
   - If not: use headless fallback
8. **Spawn (tmux path):**
   ```bash
   tmux new-window -n <name> "PI_AGENT_NAME=<name> pi --model <model> --thinking <thinking> --extension <extensionDir> '<prompt>'"
   ```
   - Capture pane/window IDs via `tmux display-message -t <name> -p '#{pane_id} #{window_id}'`
9. **Spawn (headless fallback):**
   ```typescript
   child_process.spawn("pi", ["--model", model, "--thinking", thinking, "--extension", extensionDir, "--no-session", prompt], {
     env: { ...process.env, PI_AGENT_NAME: name },
     stdio: ["ignore", "pipe", "pipe"],
     cwd,
   });
   ```
   - Track stdout as JSONL (reuse `crew/utils/progress.ts` patterns)
10. **Register:** write agent file with status `spawning`
11. **Spawn handshake:** poll mesh registry every 2s for up to `spawnTimeoutMs` (30s):
    - Look for registry entry matching `{ name }` with a valid PID
    - On found: read `sessionId` from mesh entry, update orchestrator entry with `sessionId`, transition to `joined` then `idle`
    - On timeout: kill the process, transition to `dead`, delete agent file, return error
12. **Memory bootstrap (optional):** if `memory.enabled`, search zvec for top-3 relevant entries based on the user-provided prompt, inject into a follow-up DM
13. **Log:** write history event, log to feed
14. **Return:** `{ name, model, thinking, backend, tmuxPane, status: "idle" }`

### Step 10: Auto-Join Prompt Template

The spawned agent's initial prompt:

```
Your FIRST action must be to join the messenger mesh. Call this immediately:

pi_messenger({ action: "join" })

You are "{name}", a {model} agent spawned by {orchestratorName} to work on this project.

## Your Role
- Wait for task assignments via DM from {orchestratorName}
- When you receive a task, implement it fully using the tools available to you
- When done, call: pi_messenger({ action: "agents.done", summary: "Brief description of what you did" })
- You may message {orchestratorName} at any time for clarification: pi_messenger({ action: "send", to: "{orchestratorName}", message: "..." })
- Reserve files before editing: pi_messenger({ action: "reserve", paths: ["..."] })
- Release files when done: pi_messenger({ action: "release" })

{userPrompt}
```

### Step 11: Implement `agents.list`

Input: `{ action: "agents.list" }`

Flow:
1. Read all spawned agent files from `.pi/messenger/orchestrator/agents/`
2. For each agent:
   - Verify PID liveness via `process.kill(pid, 0)` (catch ESRCH)
   - Cross-reference mesh registry for live stats (tool calls, tokens, current activity)
   - If PID dead but status not `dead`: transition to `dead`, clean up tmux, delete file
3. Format table:
   ```
   # Orchestrator Agents (3 spawned)

   🟢 Builder (openai-codex/gpt-5.3-codex:xhigh) — assigned: "Implement caching" — 42 tools, 15.2k tokens — tmux:3
   🟢 Tester (anthropic/claude-sonnet-4-6) — idle — 0 tools, 0 tokens — tmux:4
   💀 OldWorker — dead (reaped: PID exited)
   ```
4. Return formatted text + structured details

### Step 12: Implement `agents.kill`

Input: `{ action: "agents.kill", name: "Builder" }`

Flow:
1. **Validate:** get spawned agent entry, verify it exists and is not already `dead`
2. **Idempotent:** if already in `done` or `dead` state, return success (no-op)
3. **Memory capture:** if `memory.enabled` and agent has an `assignedTask`:
   - Send DM asking for completion summary: `"Before shutdown: briefly summarize what you accomplished."`
   - Wait up to 10s for a response (poll chat history)
   - If response received, embed it as `summary` type
   - If no response (agent stuck), embed a death event with last known activity from mesh registry
4. **Transition:** set status to `done` in registry
5. **Shutdown DM:** `pi_messenger({ action: "send", to: name, message: "SHUTDOWN: Release reservations and exit." })`
6. **Wait:** poll PID every 2s for `gracePeriodMs` (default 15s)
7. **Escalate:** if still alive, `process.kill(pid, 'SIGTERM')`, wait 5s
8. **Force:** if still alive, `process.kill(pid, 'SIGKILL')`
9. **tmux cleanup:** if tmux backend, `tmux kill-pane -t <paneId>` (ignore errors if pane already gone)
10. **Registry cleanup:** transition to `dead`, delete agent file
11. **Mesh cleanup:** delete mesh registry entry if still exists (`~/.pi/agent/messenger/registry/<name>.json`)
12. **Log:** history event + feed event
13. **Return:** `{ name, killed: true }`

### Step 13: Implement `agents.killall`

Input: `{ action: "agents.killall" }`

Flow:
1. Get all spawned agents not in `dead` state
2. Kill each **sequentially** (avoid race conditions)
3. Return summary: `{ killed: ["Builder", "Tester"], failed: [] }`

### Step 14: Implement `agents.logs`

Input: `{ action: "agents.logs", name: "Builder", lines?: 50 }`

Flow:
1. Get spawned agent entry
2. **tmux backend:** `tmux capture-pane -t <paneId> -p -S -<lines>` — returns raw terminal output
3. **Headless backend:** return last N lines from JSONL progress buffer
4. Return the output text

---

## Phase 4: Routing & Schema (Steps 15–16)

### Step 15: Wire Up Action Routing

**Modify:** `crew/index.ts`

Add to the switch statement in `executeCrewAction()`:

```typescript
case 'spawn': {
  const handler = await import("./handlers/orchestrator.js");
  return handler.executeSpawn(params, state, dirs, ctx);
}

case 'agents': {
  if (!op) {
    return result("Error: agents action requires operation (e.g., 'agents.list', 'agents.kill').",
      { mode: "agents", error: "missing_operation" });
  }
  const handler = await import("./handlers/orchestrator.js");
  return handler.execute(op, params, state, dirs, ctx);
}
```

The `execute(op, ...)` function in `orchestrator.ts` dispatches to:
- `list` → `executeAgentsList()`
- `kill` → `executeAgentsKill()`
- `killall` → `executeAgentsKillall()`
- `assign` → `executeAgentsAssign()`
- `check` → `executeAgentsCheck()`
- `done` → `executeAgentsDone()`
- `logs` → `executeAgentsLogs()`
- `attach` → `executeAgentsAttach()`
- `memory.stats` → `executeMemoryStats()`
- `memory.reset` → `executeMemoryReset()`

### Step 16: Update Tool Schema

**Modify:** `index.ts`

Add to the TypeBox schema in `pi.registerTool()`:

```typescript
task: Type.Optional(Type.String({ description: "Task description for agents.assign" })),
lines: Type.Optional(Type.Number({ description: "Number of lines for agents.logs (default 50)" })),
```

Update the tool description string to include orchestrator examples:

```typescript
  // Orchestrator
  pi_messenger({ action: "spawn", model: "openai-codex/gpt-5.3-codex", name: "Builder", thinking: "xhigh" })
  pi_messenger({ action: "agents.list" })
  pi_messenger({ action: "agents.assign", name: "Builder", task: "Implement X" })
  pi_messenger({ action: "agents.check", name: "Builder" })
  pi_messenger({ action: "agents.logs", name: "Builder" })
  pi_messenger({ action: "agents.kill", name: "Builder" })
  pi_messenger({ action: "agents.killall" })
  pi_messenger({ action: "agents.memory.stats" })
```

---

## Phase 5: Enhanced Messaging & Assignment (Steps 17–19)

### Step 17: Orchestrator Message Budget

**Modify:** `handlers.ts` → `executeSend()`

Currently:
```typescript
const budget = crewConfig.messageBudgets?.[crewConfig.coordination] ?? 10;
if (messagesSentThisSession >= budget) { ... }
```

Add bypass for orchestrators:
```typescript
const isOrch = isOrchestrator(); // from crew/orchestrator/registry.ts
const budget = isOrch
  ? (crewConfig.orchestrator?.messageBudget ?? 100)
  : (crewConfig.messageBudgets?.[crewConfig.coordination] ?? 10);
```

This gives orchestrators a budget of 100 (effectively unlimited for practical sessions) without removing the safety entirely.

### Step 18: Implement `agents.assign`

Input: `{ action: "agents.assign", name: "Builder", task: "Implement the Redis caching layer" }`

Flow:
1. **Validate:** agent must exist and be in `idle` or `joined` state
   - If `assigned`: return error "Agent already has a task. Wait for completion or kill."
   - If `spawning`: return error "Agent still starting up."
   - If `dead`/`done`: return error "Agent is no longer running."
2. **Memory recall:** if `memory.enabled`:
   - `recall(task, { topk: autoInjectTopK, minSimilarity, maxTokens: maxInjectionTokens })`
   - If results found, format context block:
     ```
     ## Context from prior work
     - [{agent}, {timeAgo}]: {summary text}
     - [{agent}, {timeAgo}]: {summary text}
     ```
3. **Build assignment DM:**
   ```
   # Task Assignment

   {memoryContext (if any)}

   ## Your Task
   {task}

   ## When Done
   Call: pi_messenger({ action: "agents.done", summary: "Brief description of what you did" })
   ```
4. **Send DM:** `executeSend(state, dirs, cwd, name, false, assignmentDM)`
   - If send fails: don't update registry, return error
5. **Update registry:** transition state to `assigned`, set `assignedTask: task`
6. **Log:** history event
7. **Return:** `{ name, assigned: true, memoryContextInjected: results.length > 0 }`

### Step 19: Implement `agents.done`

Input: `{ action: "agents.done", summary: "Implemented Redis caching with TTL" }`

This action is called **by the spawned agent itself** (not the orchestrator).

Flow:
1. **Identify caller:** use `state.agentName` to find the agent in orchestrator registry
   - If not found: return error "You are not a spawned orchestrator agent."
2. **Validate state:** must be in `assigned` state
3. **Embed summary:** if `memory.enabled`:
   - `remember(summary, { agent: name, type: "summary", source: "agents.done", taskId: assignedTask, files: session.filesModified })`
4. **Notify orchestrator:** DM to spawning agent:
   ```
   ✅ {name} completed: {summary}
   ```
5. **Transition state:** `assigned → idle` (or `assigned → done` if `autoKillOnDone`)
6. **Auto-kill:** if `autoKillOnDone: true`:
   - Wait 5s (let DM deliver)
   - Trigger kill sequence (Step 12, but skip memory capture since we just embedded)
7. **Log:** history event
8. **Return:** `{ done: true, autoKill: autoKillOnDone }`

---

## Phase 6: Monitoring & Cleanup (Steps 20–23)

### Step 20: Implement `agents.check`

Input: `{ action: "agents.check", name: "Builder" }`

Flow:
1. Read orchestrator registry entry
2. Check PID liveness
3. Cross-reference mesh registry for: tool calls, tokens, current activity, status message, files modified, last activity time
4. Read chat history for last DM from/to this agent
5. Return formatted status:
   ```
   # Builder
   🟢 Status: assigned
   Model: openai-codex/gpt-5.3-codex:xhigh
   Task: Implement Redis caching layer
   Uptime: 12m 34s
   Activity: editing src/cache.py (3s ago)
   Tools: 42 calls, 15.2k tokens
   Last message: "Working on cache invalidation now"
   Files modified: src/cache.py, tests/test_cache.py
   tmux: pane %3
   ```

### Step 21: PID Health Monitoring

**Modify:** `index.ts`

Hook into the existing heartbeat timer (`STATUS_HEARTBEAT_MS = 15_000`):

In the heartbeat callback (where `updateStatus(ctx)` is called), add:

```typescript
if (isOrchestrator()) {
  const reaped = checkSpawnedAgentHealth(ctx);
  for (const name of reaped) {
    ctx.ui.notify(`⚠️ Spawned agent ${name} died unexpectedly`, "warning");
  }
}
```

`checkSpawnedAgentHealth()` in `crew/orchestrator/registry.ts`:
1. Iterate all spawned agents not in `dead` state
2. Check PID liveness via `process.kill(pid, 0)`
3. If dead: transition to `dead`, clean up tmux pane, delete agent file
4. Return list of reaped agent names

### Step 22: Idle Detection

In the same heartbeat callback:

```typescript
if (isOrchestrator()) {
  const idle = checkIdleAgents(config.orchestrator.idleTimeoutMs);
  for (const { name, idleFor } of idle) {
    ctx.ui.notify(`⏰ ${name} idle for ${idleFor}. Kill? agents.kill({ name: "${name}" })`, "info");
  }
}
```

`checkIdleAgents()`:
1. For each agent in `idle` state (NOT `assigned` — assigned agents may be thinking):
   - Read `lastActivityAt` from mesh registry
   - If idle > `idleTimeoutMs`: add to warning list
2. Only warn once per agent (track notified set, clear when agent becomes active)

No auto-kill — just warnings. The orchestrator decides.

### Step 23: Implement `agents.attach`

Input: `{ action: "agents.attach", name: "Builder" }`

Flow:
1. Get spawned agent entry
2. If headless backend: return "Agent is running in headless mode. Use agents.logs instead."
3. If tmux: return the command to run:
   ```
   To attach: tmux select-window -t <windowId>
   ```
4. Alternatively, if the orchestrator is in tmux, switch directly via `child_process.execSync("tmux select-window -t ...")`

---

## Phase 7: Overlay, Skill & Polish (Steps 24–28)

### Step 24: Update `/messenger` Overlay

**Modify:** `overlay.ts`, `overlay-render.ts`, `overlay-actions.ts`

**Important:** Read the current overlay architecture before implementing. The overlay may have evolved from the original tab-based design. Adapt to whatever the current pattern is.

Conceptual additions:
- Show spawned agents section (name, model, state, task, tokens)
- Keybindings: `[s]` spawn, `[k]` kill, `[m]` message, `[a]` assign
- Memory stats if enabled

This is the **lowest priority step** — the tool API is fully functional without overlay changes.

### Step 25: Create Orchestrator Skill File

**Create:** `skills/pi-messenger-orchestrator/SKILL.md`

```markdown
---
name: pi-messenger-orchestrator
description: Spawn, manage, and coordinate persistent worker agents with shared memory. Use when orchestrating multi-agent workflows with ongoing guidance.
---

# Pi-Messenger Orchestrator Skill

Spawn persistent worker agents, assign tasks, communicate via DM, and manage lifecycle.

## Quick Start

### 1. Join the Mesh (Required)
```typescript
pi_messenger({ action: "join" })
```

### 2. Spawn a Worker
```typescript
pi_messenger({ action: "spawn", model: "openai-codex/gpt-5.3-codex", name: "Builder", thinking: "xhigh" })
```

Options:
- `model` — LLM model (default: from config)
- `name` — agent name (default: auto-generated)
- `thinking` — thinking level: off, minimal, low, medium, high, xhigh
- `prompt` — additional instructions appended to default prompt

### 3. Assign a Task
```typescript
pi_messenger({ action: "agents.assign", name: "Builder", task: "Implement Redis caching in src/cache.py" })
```

If memory is enabled, relevant context from prior agent work is automatically injected.

### 4. Communicate
```typescript
// Send guidance
pi_messenger({ action: "send", to: "Builder", message: "Use TTL-based invalidation, not event-driven" })

// Check status
pi_messenger({ action: "agents.check", name: "Builder" })

// View logs
pi_messenger({ action: "agents.logs", name: "Builder" })

// List all agents
pi_messenger({ action: "agents.list" })
```

### 5. Lifecycle
```typescript
// Kill specific agent
pi_messenger({ action: "agents.kill", name: "Builder" })

// Kill all
pi_messenger({ action: "agents.killall" })

// Attach to tmux pane (for debugging)
pi_messenger({ action: "agents.attach", name: "Builder" })
```

### 6. Memory
```typescript
// View memory stats
pi_messenger({ action: "agents.memory.stats" })

// Reset memory (if embedding model changed)
pi_messenger({ action: "agents.memory.reset" })
```

## How Workers Signal Completion

Spawned agents call this when done:
```typescript
pi_messenger({ action: "agents.done", summary: "Brief description of what was accomplished" })
```

If `autoKillOnDone` is enabled (default), the agent is killed after signaling done.

## Configuration

In `~/.pi/agent/pi-messenger.json`:
```json
{
  "crew": {
    "orchestrator": {
      "defaultModel": "anthropic/claude-sonnet-4-6",
      "defaultThinking": "high",
      "maxSpawnedAgents": 5,
      "autoKillOnDone": true,
      "memory": {
        "enabled": true,
        "embeddingModel": "text-embedding-3-small"
      }
    }
  }
}
```

## Typical Session

```typescript
// Join mesh
pi_messenger({ action: "join" })

// Spawn workers
pi_messenger({ action: "spawn", model: "openai-codex/gpt-5.3-codex", name: "Builder", thinking: "xhigh" })
pi_messenger({ action: "spawn", model: "anthropic/claude-sonnet-4-6", name: "Tester" })

// Assign work
pi_messenger({ action: "agents.assign", name: "Builder", task: "Implement the auth module with JWT" })

// Monitor & guide
pi_messenger({ action: "agents.check", name: "Builder" })
pi_messenger({ action: "send", to: "Builder", message: "Add rate limiting to the login endpoint" })

// Builder calls agents.done → auto-killed
// Assign tests to Tester
pi_messenger({ action: "agents.assign", name: "Tester", task: "Write tests for the auth module Builder just created" })
// Tester gets memory context from Builder's work summary automatically

// Cleanup
pi_messenger({ action: "agents.killall" })
```
```

### Step 26: Session Shutdown Cleanup

**Modify:** `index.ts` → `session_shutdown` handler

Add before existing cleanup:

```typescript
// Kill all orchestrator-spawned agents
const { killAllSpawned } = await import("./crew/orchestrator/registry.js");
killAllSpawned(process.cwd());

// Close memory store
const { closeMemory } = await import("./crew/orchestrator/memory.js");
closeMemory();
```

### Step 27: Startup Orphan Reconciliation

**Modify:** `index.ts` → `session_start` handler

Add after existing restoration logic:

```typescript
// Reap orphaned orchestrator agents
const { reapOrphans } = await import("./crew/orchestrator/registry.js");
const reaped = reapOrphans();
if (reaped.length > 0 && ctx.hasUI) {
  ctx.ui.notify(`Reaped ${reaped.length} orphaned agent(s): ${reaped.join(", ")}`, "info");
}

// Initialize memory store (if enabled)
const crewDir = join(ctx.cwd ?? process.cwd(), ".pi", "messenger", "crew");
const crewConfig = loadCrewConfig(crewDir);
if (crewConfig.orchestrator.memory.enabled) {
  const { initMemory } = await import("./crew/orchestrator/memory.js");
  try {
    await initMemory(ctx.cwd ?? process.cwd(), crewConfig.orchestrator.memory);
  } catch (e) {
    if (ctx.hasUI) {
      ctx.ui.notify(`Memory store failed to initialize: ${e instanceof Error ? e.message : "unknown"}. Memory disabled.`, "warning");
    }
  }
}
```

### Step 28: End-to-End Testing

Manual integration test checklist:

1. ☐ Spawn agent via `spawn` — verify it appears in tmux AND mesh registry
2. ☐ Verify spawn handshake — agent joins within 30s
3. ☐ `agents.list` — shows correct status, model, PID
4. ☐ `agents.assign` — agent receives task DM, starts working
5. ☐ Memory injection — verify context from prior work appears in assignment DM
6. ☐ DM exchange — send guidance, agent responds
7. ☐ `agents.check` — shows current activity, tokens, files
8. ☐ `agents.logs` — returns tmux pane output
9. ☐ `agents.done` — agent calls it, summary embedded in memory
10. ☐ Auto-kill — agent killed after `agents.done` (if enabled)
11. ☐ `agents.kill` — manual kill, verify tmux pane closed
12. ☐ `agents.killall` — kills all remaining agents
13. ☐ Session restart — verify orphan reaping on startup
14. ☐ Memory persistence — spawn new agent, verify it receives memory from prior agent
15. ☐ Headless fallback — test without tmux available
16. ☐ Error cases: spawn at limit, kill dead agent, assign to dead agent, name collision

---

## File Map — What Goes Where

### New Files

```
crew/orchestrator/
├── registry.ts         # Spawned agent registry, state machine, orphan reaping
├── memory.ts           # zvec memory store (init, remember, recall, prune)
├── embedding.ts        # Embedding API wrapper (provider-agnostic)
└── types.ts            # Shared types (SpawnedAgent, MemoryEntry, etc.)

crew/handlers/
└── orchestrator.ts     # All orchestrator action handlers (spawn, kill, assign, etc.)

skills/pi-messenger-orchestrator/
└── SKILL.md            # Auto-discovered skill file
```

### Modified Files

```
crew/index.ts           # Add spawn + agents action routing
crew/utils/config.ts    # Add orchestrator config section + defaults
handlers.ts             # Message budget bypass for orchestrators
index.ts                # session_start (reap + memory init), session_shutdown (kill + close), heartbeat (health + idle)
package.json            # Add @zvec/zvec dependency
```

### Runtime Data (project-scoped, gitignored)

```
<project>/.pi/messenger/orchestrator/
├── agents/
│   ├── Builder.json        # Per-agent state file
│   └── Tester.json
├── memory/                 # zvec collection files
│   └── (zvec internal files)
└── history.jsonl           # Spawn/kill/assign event log
```

---

## Reviewed Failure Modes & Mitigations

These were identified by adversarial reviews from GPT-5.3-codex (two rounds) and incorporated into the plan.

| Failure Mode | Mitigation |
|-------------|------------|
| Spawn handshake fails (agent doesn't join) | 30s timeout with polling. Kill process and return error on timeout. |
| Name collision | Check both registries before spawn. Retry with new name up to 5 times. |
| Stale inbox messages from previous agent with same name | Clear inbox directory before spawning. |
| PID reuse (OS assigns dead PID to new process) | Verify PID tuple: `{name, pid, sessionId, spawnedAt}`. Not just PID alone. |
| Single agents.json race condition | Per-agent files with atomic temp+rename writes (matches mesh registry pattern). |
| Assign to pre-join agent | State machine prevents: must be in `idle` state. |
| Kill races with assignment | State machine: kill transitions through `done→dead`. Assignment checks state before write. |
| Orchestrator crashes mid-kill | Startup orphan reaping cleans up. |
| Context drift in long-lived agents | zvec memory persists knowledge. Agents can be killed/respawned without losing context. |
| Embedding API outage | Circuit breaker (3 failures → 60s cooldown). Degraded mode returns empty, doesn't crash. |
| Embedding dimension mismatch after model change | Startup check compares collection metadata vs config. Fail fast with clear error. |
| Duplicate memory entries | Content hash dedup on insert. |
| Memory growth unbounded | `maxEntries` with importance-based eviction + TTL-based pruning on startup. |
| zvec native module crash | Startup health check (insert/query/delete). Auto-disable with warning on failure. |
| tmux unavailable | Headless fallback via child_process.spawn(). |
| Silent behavior changes when memory fails | Explicit degraded mode — `{ ok: false, degraded: true }` return values. Notify via `ctx.ui.notify()`. |
| Message budget too low for orchestrator | Elevated budget (100) instead of default (10). Not unlimited. |
| fs.watch misses inbox events | Existing pi-messenger pattern handles this with retry logic. |

---

## Testing Checklist

### Functional Tests
- [ ] Spawn agent with tmux backend — joins mesh
- [ ] Spawn agent with headless fallback
- [ ] Spawn timeout — agent doesn't join, cleaned up
- [ ] Name collision — auto-generates new name
- [ ] Max agents limit enforced
- [ ] agents.list shows correct info
- [ ] agents.kill graceful shutdown sequence
- [ ] agents.killall kills all
- [ ] agents.assign delivers task with memory context
- [ ] agents.done embeds summary, notifies orchestrator
- [ ] Auto-kill after done (when enabled)
- [ ] agents.check returns accurate status
- [ ] agents.logs returns tmux output
- [ ] agents.attach returns correct tmux command
- [ ] Memory persistence across session restart
- [ ] Orphan reaping on startup

### Error Cases
- [ ] Kill already-dead agent → no-op
- [ ] Assign to dead agent → error
- [ ] Assign to already-assigned agent → error
- [ ] Spawn when at limit → error
- [ ] Embedding API down → degraded mode, no crash
- [ ] zvec init failure → memory disabled, warning shown
- [ ] Dimension mismatch → clear error message
- [ ] Duplicate memory entries → deduped by content hash

---

## Kickoff Prompt

See the next section for the exact prompt to give to the implementing agent.
