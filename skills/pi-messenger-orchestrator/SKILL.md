---
name: pi-messenger-orchestrator
description: Spawn, manage, and coordinate persistent worker agents with shared memory. Use when orchestrating multi-agent workflows with ongoing guidance.
---

# Pi-Messenger Orchestrator Skill

Spawn persistent worker agents, assign tasks, communicate via DM, manage lifecycle, and capture/filter/export session data for training.

## Quick Start

### 1. Join the Mesh (Required)
```typescript
pi_messenger({ action: "join" })
```

### 2. Spawn a Worker
```typescript
// Preferred: stable profile (project/local frontmatter controls model/provider)
pi_messenger({ action: "spawn", profile: "worker-xhigh", name: "Builder" })

// Explicit model/provider (canonical model naming)
pi_messenger({ action: "spawn", model: "anthropic/claude-opus-4-6", name: "Builder", thinking: "medium" })
pi_messenger({ action: "spawn", model: "openai-codex/gpt-5.3-codex", name: "Coder", thinking: "xhigh" })
```

### 3. Assign a Task
```typescript
pi_messenger({ action: "agents.assign", name: "Builder", task: "Implement Redis caching in src/cache.py", workstream: "backtester" })
```

### 4. Communicate and Monitor
```typescript
pi_messenger({ action: "send", to: "Builder", message: "Use TTL-based invalidation" })
pi_messenger({ action: "agents.check", name: "Builder" })
pi_messenger({ action: "agents.logs", name: "Builder" })
pi_messenger({ action: "agents.list" })
```

### 5. Lifecycle
```typescript
pi_messenger({ action: "agents.kill", name: "Builder" })
pi_messenger({ action: "agents.killall" })
pi_messenger({ action: "agents.attach", name: "Builder" })
```

### 6. Memory
```typescript
pi_messenger({ action: "agents.memory.stats" })
pi_messenger({ action: "agents.memory.reset" })
```

Memory behavior is automatic when enabled:
- On `agents.done`, summaries are embedded and stored in zvec.
- On `agents.assign`, relevant prior summaries are recalled and injected into the assignment.

Use `workstream` tags (e.g., `cvi-wing`, `backtester`) to isolate recall context within the same repo.

### 7. Data Policy + Training Corpus
```typescript
// Set session tags (recommended at start of a work session)
pi_messenger({ action: "data.session", project: "bergomi2", runType: "production" })

// Inspect captured corpus health (counts, categories, training-eligible totals)
pi_messenger({ action: "data.stats" })

// Export training-ready JSONL (usually filtered to your project)
pi_messenger({ action: "data.export", project: "bergomi2", out: ".pi/messenger/data/exports/bergomi2.jsonl" })

// Run retention/cleanup immediately
pi_messenger({ action: "data.retention" })
```

`data.*` actions are local maintenance/export commands and can be run before or after mesh join.

Run types:
- `production` → intended project implementation work
- `smoke` → smoke/probe/testing sessions
- `research` → exploratory sessions
- `debug` → operational troubleshooting

Default category behavior (policy-driven):
- `production_work`: full storage, training included (subject to project allowlist)
- `smoke_test`: summary storage, excluded from training
- `off_topic`: payload dropped (metadata only), excluded from training
- `ops_debug`: summary storage, excluded from training

## Deterministic Smoke Test (Recommended)

Use this exact sequence for orchestration validation:

```typescript
// 0) mark this as smoke so it doesn't pollute production training corpus
pi_messenger({ action: "data.session", project: "bergomi2", runType: "smoke" })

// 1) join
pi_messenger({ action: "join" })

// 2) spawn
pi_messenger({ action: "spawn", profile: "worker-xhigh", name: "SmokeWorker", thinking: "medium" })

// 3) assign
pi_messenger({ action: "agents.assign", name: "SmokeWorker", task: "Create /tmp/smoke.txt with content 'ok' and report completion", workstream: "smoke" })

// 4) DM round-trip
pi_messenger({ action: "send", to: "SmokeWorker", message: "Confirm the file path in your done summary." })

// 5) kill/respawn
pi_messenger({ action: "agents.kill", name: "SmokeWorker" })
pi_messenger({ action: "spawn", profile: "worker-xhigh", name: "SmokeWorker", thinking: "medium", prompt: "You previously worked on smoke tasks." })

// 6) verify memory recall after respawn
pi_messenger({ action: "agents.assign", name: "SmokeWorker", task: "Repeat smoke task and include any recalled context.", workstream: "smoke" })

// 7) switch back for real project work
pi_messenger({ action: "data.session", project: "bergomi2", runType: "production" })
```

Expected outcomes:
- Spawn reaches `idle`.
- Assignment moves agent to `assigned`.
- DM exchange appears in feed/logs.
- Respawn succeeds with same agent name.
- Subsequent assignment shows memory context injection when prior summaries exist.
- `data.stats` shows smoke activity categorized away from production training data.

## Spawn Timeout Triage

If spawn times out:
1. `pi_messenger({ action: "agents.logs", name: "<agent>" })`
2. `pi_messenger({ action: "agents.check", name: "<agent>" })`
3. `pi_messenger({ action: "agents.list" })`
4. Inspect diagnostics path returned by the timeout error (tmux/headless tail + PID diagnostics).

## Worker Completion Signal

Spawned agents should call:
```typescript
pi_messenger({ action: "agents.done", summary: "Brief description of what was accomplished" })
```

If `autoKillOnDone` is enabled, the agent is automatically terminated after reporting done.
