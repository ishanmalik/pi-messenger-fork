<p>
  <img src="banner.png" alt="pi-messenger" width="1100">
</p>

# Pi Messenger

**What if multiple agents in different terminals sharing a folder could talk to each other like they're in a chat room?** Join, see who's online. Claim tasks, reserve files, send messages. Built on [Pi's](https://github.com/badlogic/pi-mono) extension system. No daemon, no server, just files.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-macOS%20%7C%20Linux-blue?style=for-the-badge)]()

> ⚠️ **Beta** — This extension is still in active development and not fully tested. More updates coming soon.

```typescript
pi_messenger({ join: true, spec: "./tasks.md" })
pi_messenger({ claim: "TASK-01", reason: "Implementing login flow" })
pi_messenger({ to: "GoldFalcon", message: "Done with auth, ready for review" })
```

## Quick Start

```typescript
// Join the agent chat
pi_messenger({ join: true })
// → "Joined as SwiftRaven in backend on main. 2 peers active."

// See who's online
pi_messenger({ list: true })

// Send a message (wakes recipient immediately)
pi_messenger({ to: "GoldFalcon", message: "Taking the auth routes" })

// Reserve files (blocks other agents)
pi_messenger({ reserve: ["src/auth/"], reason: "Refactoring" })

// Release when done
pi_messenger({ release: true })
```

## Install

Copy to your extensions directory and restart pi:

```
~/.pi/agent/extensions/pi-messenger/
```

After joining, your agent name appears in the status bar:

```
msg: SwiftRaven (2 peers) ●3
```

## Features

**Discovery** — Agents register with memorable names (SwiftRaven, IronKnight). See who's active, what model they're using, which git branch they're on.

**Messaging** — Send messages between agents. Recipients wake up immediately and see the message as a steering prompt. Great for handoffs and coordination.

**File Reservations** — Claim files or directories. Other agents get blocked with a clear message telling them who to coordinate with. Auto-releases on exit.

**Swarm Coordination** — Multiple agents work on the same spec file. Claim tasks atomically, mark them complete, see who's doing what.

## Swarm Mode

When multiple agents work on the same spec:

```typescript
// Join with a spec file
pi_messenger({ join: true, spec: "./feature-spec.md" })

// See what's claimed and completed
pi_messenger({ swarm: true })
// → Completed: TASK-01, TASK-02
//   In progress: TASK-03 (you), TASK-04 (GoldFalcon)

// Claim a task (fails if already taken)
pi_messenger({ claim: "TASK-05" })

// Mark complete with notes
pi_messenger({ complete: "TASK-05", notes: "Added error handling" })
```

One claim per agent at a time. Claims are atomic and auto-cleanup when agents exit.

## Crew: Task Orchestration

Crew extends pi-messenger with multi-agent task orchestration for complex epics:

```typescript
// Create an epic
pi_messenger({ action: "epic.create", title: "Add OAuth Login" })
// → Created epic c-1-abc: Add OAuth Login

// Plan the epic (runs 7 scouts, creates tasks)
pi_messenger({ action: "plan", target: "c-1-abc" })
// → Created 4 tasks with dependencies

// Execute tasks (spawns parallel workers)
pi_messenger({ action: "work", target: "c-1-abc", autonomous: true })
// → Wave 1: Running c-1-abc.1, c-1-abc.2...

// Review implementation
pi_messenger({ action: "review", target: "c-1-abc.1" })
// → SHIP ✅ or NEEDS_WORK 🔄
```

### Crew Actions

**Epic Management**
| Action | Description | Example |
|--------|-------------|---------|
| `epic.create` | Create new epic | `{ action: "epic.create", title: "OAuth" }` |
| `epic.show` | Show epic details | `{ action: "epic.show", id: "c-1-abc" }` |
| `epic.list` | List all epics | `{ action: "epic.list" }` |
| `epic.close` | Close completed epic | `{ action: "epic.close", id: "c-1-abc" }` |
| `epic.set_spec` | Update epic spec | `{ action: "epic.set_spec", id: "c-1-abc", content: "..." }` |

**Task Management**
| Action | Description | Example |
|--------|-------------|---------|
| `task.create` | Create task | `{ action: "task.create", epic: "c-1-abc", title: "Config" }` |
| `task.show` | Show task details | `{ action: "task.show", id: "c-1-abc.1" }` |
| `task.list` | List tasks in epic | `{ action: "task.list", epic: "c-1-abc" }` |
| `task.start` | Start task | `{ action: "task.start", id: "c-1-abc.1" }` |
| `task.done` | Complete task | `{ action: "task.done", id: "c-1-abc.1", summary: "..." }` |
| `task.block` | Block task | `{ action: "task.block", id: "c-1-abc.1", reason: "..." }` |
| `task.unblock` | Unblock task | `{ action: "task.unblock", id: "c-1-abc.1" }` |
| `task.ready` | List ready tasks | `{ action: "task.ready", epic: "c-1-abc" }` |
| `task.reset` | Reset task to todo | `{ action: "task.reset", id: "c-1-abc.1", cascade: true }` |

**Orchestration**
| Action | Description | Example |
|--------|-------------|---------|
| `plan` | Run scouts + create tasks | `{ action: "plan", target: "c-1-abc" }` |
| `work` | Execute ready tasks | `{ action: "work", target: "c-1-abc" }` |
| `review` | Review code or plan | `{ action: "review", target: "c-1-abc.1" }` |
| `interview` | Generate clarification questions | `{ action: "interview", target: "c-1-abc" }` |
| `sync` | Update downstream task specs | `{ action: "sync", target: "c-1-abc.1" }` |

**Status & Maintenance**
| Action | Description | Example |
|--------|-------------|---------|
| `crew.status` | Overall status | `{ action: "crew.status" }` |
| `crew.validate` | Validate epic structure | `{ action: "crew.validate", id: "c-1-abc" }` |
| `crew.agents` | List available crew agents | `{ action: "crew.agents" }` |
| `crew.install` | Install/update crew agents | `{ action: "crew.install" }` |
| `crew.uninstall` | Remove crew agents | `{ action: "crew.uninstall" }` |

> **Note:** Crew agents are auto-installed on first use of `plan`, `work`, or `review`.

### Planning Workflow

The `plan` action orchestrates a multi-agent analysis:

```
┌─────────────────────────────────────────────────────────────────┐
│  Your Project                                                    │
│  ├── PRD.md            ◄── Scouts discover and read these       │
│  ├── DESIGN.md                                                   │
│  ├── src/                                                        │
│  └── ...                                                         │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Phase 1: Scouts (parallel)                                      │
│  ├── crew-repo-scout      → Analyzes codebase structure          │
│  ├── crew-docs-scout      → Reads project documentation          │
│  ├── crew-practice-scout  → Finds similar patterns               │
│  ├── crew-github-scout    → Checks issues/PRs if available       │
│  └── ... (7 scouts total)                                        │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Phase 2: Gap Analyst                                            │
│  └── Synthesizes findings → Creates task breakdown               │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Result: Tasks with Dependencies                                 │
│  ├── c-1-abc.1: Setup types        (no deps)                    │
│  ├── c-1-abc.2: Core logic         (depends on 1)               │
│  ├── c-1-abc.3: API endpoints      (depends on 1)               │
│  └── c-1-abc.4: Tests              (depends on 2, 3)            │
└─────────────────────────────────────────────────────────────────┘
```

**No special format required** - just put your docs in the project. Scouts will find and read markdown files, READMEs, and code comments. The gap-analyst handles the task decomposition.

```typescript
// Example: Start with a PRD
// 1. Copy your PRD into the project
// 2. Create epic from idea
pi_messenger({ action: "plan", target: "Build OAuth login per PRD.md", idea: true })
// → Scouts analyze PRD.md + codebase
// → Gap-analyst creates 5 tasks with dependencies
// → Ready for work!
```

### Autonomous Mode

Run tasks continuously until completion:

```typescript
pi_messenger({ action: "work", target: "c-1-abc", autonomous: true })
```

Autonomous mode:
- Executes waves of parallel workers
- Reviews each task after completion
- Auto-blocks on failure
- Stops when all tasks done or blocked
- Respects `maxWaves` limit (default: 50)

### Crew Overlay Tab

The `/messenger` overlay includes a Crew tab showing epic/task status:

```
╭─ Messenger ── SwiftRaven ── 2 peers ─────────────────╮
│ Agents │ ▸ Crew (1) │ ● GoldFalcon │ + All           │
├──────────────────────────────────────────────────────┤
│ ▸ 🚀 c-1-abc: OAuth Login                    [2/4]  │
│    ├─ ✓ c-1-abc.1  Configure OAuth                  │
│    ├─ ● c-1-abc.2  Google OAuth (SwiftRaven)        │
│    ├─ ● c-1-abc.3  GitHub OAuth (GoldFalcon)        │
│    └─ ○ c-1-abc.4  Login UI → deps: 2, 3            │
│                                                      │
│ Legend: ✓ done  ● in_progress  ○ todo  ✗ blocked    │
├──────────────────────────────────────────────────────┤
│ ● AUTO Wave 2 │ 2/4 tasks │ 1 ready │ ⏱️ 3:42       │
╰──────────────────────────────────────────────────────╯
```

### Crew Data Storage

```
.pi/messenger/crew/
├── epics/c-1-abc.json      # Epic metadata
├── specs/c-1-abc.md        # Epic specification
├── tasks/c-1-abc.1.json    # Task metadata
├── tasks/c-1-abc.1.md      # Task specification
├── checkpoints/            # Saved state for recovery
└── artifacts/              # Debug artifacts
```

### Crew Configuration

Add to `~/.pi/agent/pi-messenger.json`:

```json
{
  "crew": {
    "concurrency": { "scouts": 4, "workers": 2 },
    "review": { "enabled": true, "maxIterations": 3 },
    "work": { "maxAttemptsPerTask": 5, "maxWaves": 50 },
    "artifacts": { "enabled": true, "cleanupDays": 7 }
  }
}
```

### Checkpoints

Save and restore epic state for recovery:

```typescript
// Save current state
pi_messenger({ action: "checkpoint.save", id: "c-1-abc" })

// Restore from checkpoint (rollback)
pi_messenger({ action: "checkpoint.restore", id: "c-1-abc" })

// List all checkpoints
pi_messenger({ action: "checkpoint.list" })

// Delete checkpoint
pi_messenger({ action: "checkpoint.delete", id: "c-1-abc" })
```

## Chat Overlay

`/messenger` opens an interactive chat UI:

```
╭─ Messenger ── SwiftRaven ── 2 peers ────────────────╮
│ ▸ Agents │ ● GoldFalcon │ ● IronKnight (1) │ + All  │
├─────────────────────────────────────────────────────┤
│ ./feature-spec.md:                                  │
│   SwiftRaven (you)   TASK-03    Implementing auth   │
│   GoldFalcon         TASK-04    API endpoints       │
├─────────────────────────────────────────────────────┤
│ > Agents overview                    [Tab] [Enter]  │
╰─────────────────────────────────────────────────────╯
```

| Key | Action |
|-----|--------|
| `Tab` / `←` `→` | Switch tabs |
| `↑` `↓` | Scroll history |
| `Enter` | Send message |
| `Esc` | Close |

## Tool Reference

### Action-Based API (Recommended)

```typescript
pi_messenger({
  action: string,              // Action to perform
  
  // Crew identifiers
  id?: string,                 // Epic or task ID (c-1-abc or c-1-abc.1)
  target?: string,             // Target for plan/work/review
  
  // Creation
  title?: string,              // For epic.create, task.create
  epic?: string,               // Parent epic for task operations
  dependsOn?: string[],        // Task dependencies
  
  // Completion
  summary?: string,            // For task.done
  
  // Work options
  autonomous?: boolean,        // Run continuously
  concurrency?: number,        // Override concurrency
  
  // Review
  type?: "plan" | "impl",      // Review type
})
```

### Legacy API

```typescript
pi_messenger({
  // Join
  join?: boolean,              // Join the agent mesh
  spec?: string,               // Spec file to work on

  // Swarm
  swarm?: boolean,             // Get swarm status
  claim?: string,              // Claim a task
  unclaim?: string,            // Release without completing
  complete?: string,           // Mark task complete
  notes?: string,              // Completion notes

  // Messaging
  to?: string | string[],      // Recipient(s)
  broadcast?: boolean,         // Send to all
  message?: string,            // Message text

  // Reservations
  reserve?: string[],          // Paths to reserve
  reason?: string,             // Why reserving/claiming
  release?: string[] | true,   // Release reservations

  // Other
  rename?: string,             // Change your name
  list?: boolean,              // List active agents
})
```

## Configuration

Create `~/.pi/agent/pi-messenger.json`:

```json
{
  "autoRegister": false,
  "autoRegisterPaths": ["~/projects/team-collab"],
  "scopeToFolder": false
}
```

| Setting | Description | Default |
|---------|-------------|---------|
| `autoRegister` | Join mesh on startup | `false` |
| `autoRegisterPaths` | Folders where auto-join is enabled | `[]` |
| `scopeToFolder` | Only see agents in same directory | `false` |

**Path-based auto-register**: Use `autoRegisterPaths` instead of global auto-register. Supports `~` expansion and globs (`~/work/*`).

**Folder scoping**: When enabled, agents only discover others in the same working directory. Direct messaging by name still works across folders.

Manage paths via `/messenger config` or:

```typescript
pi_messenger({ autoRegisterPath: "add" })
pi_messenger({ autoRegisterPath: "list" })
```

## How It Works

```
~/.pi/agent/messenger/
├── registry/           # Agent registrations (PID, cwd, model, spec)
├── inbox/              # Message delivery
├── claims.json         # Active task claims
├── completions.json    # Completed tasks
└── swarm.lock          # Atomic lock for claims
```

File-based coordination. No daemon. Dead agents detected via PID and cleaned up automatically.

## Credits

- **[mcp_agent_mail](https://github.com/Dicklesworthstone/mcp_agent_mail)** by [@doodlestein](https://x.com/doodlestein) — Inspiration for agent-to-agent messaging
- **[Pi coding agent](https://github.com/badlogic/pi-mono/)** by [@badlogicgames](https://x.com/badlogicgames)

## License

MIT
