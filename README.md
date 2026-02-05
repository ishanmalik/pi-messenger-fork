<p>
  <img src="https://raw.githubusercontent.com/nicobailon/pi-messenger/main/banner.png" alt="pi-messenger" width="1100">
</p>

# Pi Messenger

**What if multiple agents in different terminals sharing a folder could talk to each other like they're in a chat room?** Join, see who's online and what they're doing. Claim tasks, reserve files, send messages. Built on [Pi's](https://github.com/badlogic/pi-mono) extension system. No daemon, no server, just files.

[![npm version](https://img.shields.io/npm/v/pi-messenger?style=for-the-badge)](https://www.npmjs.com/package/pi-messenger)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-macOS%20%7C%20Linux-blue?style=for-the-badge)]()

## Installation

```bash
pi install npm:pi-messenger
```

Crew agents and the `pi-messenger-crew` skill are auto-installed to `~/.pi/agent/agents/` and `~/.pi/agent/skills/` on first use of `plan`, `work`, or `review`. To install them manually:

```typescript
pi_messenger({ action: "crew.install" })
```

To remove:

```bash
npx pi-messenger --remove
```

This removes the extension. To also remove crew agents and skill: `pi_messenger({ action: "crew.uninstall" })` before removing.

## Quick Start

Once joined (manually or via `autoRegister` config), agents can coordinate:

```typescript
pi_messenger({ action: "join" })
pi_messenger({ action: "reserve", paths: ["src/auth/"], reason: "Refactoring" })
pi_messenger({ action: "send", to: "GoldFalcon", message: "auth is done" })
pi_messenger({ action: "release" })
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

**File Reservations** - Claim files or directories. Other agents get blocked with a clear message telling them who to coordinate with. Auto-releases on exit.

**Stuck Detection** - Agents idle too long with an open task or reservation are flagged as stuck. Peers get a notification.

**Human as Participant** - Your interactive pi session appears in the agent list with `(you)`. Same activity tracking, same status messages. Chat from the overlay.

## Chat Overlay

`/messenger` opens an interactive overlay with agent presence, activity feed, and chat:

<img width="722" height="351" alt="pi-messenger chat overlay" src="https://github.com/user-attachments/assets/4d0f1db7-90dd-4ffb-9463-560426edebd9" />

Chat input supports `@Name msg` for DMs and `@all msg` for broadcasts. Text without `@` broadcasts from the Agents tab or DMs the selected agent tab.

| Key | Action |
|-----|--------|
| `Tab` / `←` `→` | Switch tabs (Agents, Crew, agent DMs, All) |
| `↑` `↓` | Scroll history / navigate crew tasks |
| `Enter` | Send message |
| `Esc` | Close |

## Crew: Task Orchestration

Crew turns a PRD into a dependency graph of tasks, then executes them in parallel waves.

### Workflow

1. **Plan** — Planner explores the codebase and PRD, drafts tasks with dependencies. A reviewer checks the plan; the planner refines until SHIP or `maxPasses` is reached. History is stored in `planning-progress.md`.
2. **Work** — Workers implement ready tasks (all dependencies met) in parallel waves. A single `work` call runs one wave. `autonomous: true` runs waves back-to-back until everything is done or blocked.
3. **Review** — Reviewer checks each implementation: SHIP, NEEDS_WORK, or MAJOR_RETHINK.

No special PRD format required — the planner auto-discovers `PRD.md`, `SPEC.md`, `DESIGN.md`, etc. in your project root and `docs/`.

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

### Crew Configuration

Add to `~/.pi/agent/pi-messenger.json`:

```json
{
  "crew": {
    "concurrency": { "workers": 2 },
    "review": { "enabled": true, "maxIterations": 3 },
    "planning": { "maxPasses": 3 },
    "work": { "maxAttemptsPerTask": 5, "maxWaves": 50 }
  }
}
```

Crew agents (planner, worker, reviewer, interview-generator, plan-sync) are **auto-installed** on first use. Run `{ action: "crew.install" }` to manually install or update.

## API Reference

### Coordination

| Action | Description |
|--------|-------------|
| `join` | Join the agent mesh |
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

### Crew

| Action | Description |
|--------|-------------|
| `plan` | Create plan from PRD (`prd` optional — auto-discovers if omitted) |
| `work` | Run ready tasks (`autonomous`, `concurrency` optional) |
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
| `crew.install` | Install/update crew agents |
| `crew.uninstall` | Remove crew agents and skill |

### Swarm (Spec-Based)

| Action | Description |
|--------|-------------|
| `swarm` | Show swarm task status |
| `claim` | Claim a task (`taskId` required) |
| `unclaim` | Release a claim (`taskId` required) |
| `complete` | Complete a task (`taskId` required) |

## Configuration

Create `~/.pi/agent/pi-messenger.json`:

```json
{
  "autoRegister": false,
  "autoRegisterPaths": ["~/projects/team-collab"],
  "scopeToFolder": false,
  "nameTheme": "default",
  "stuckThreshold": 900,
  "stuckNotify": true
}
```

| Setting | Description | Default |
|---------|-------------|---------|
| `autoRegister` | Join mesh on startup | `false` |
| `autoRegisterPaths` | Folders where auto-join is enabled (supports `*` globs) | `[]` |
| `scopeToFolder` | Only see agents in same directory | `false` |
| `nameTheme` | Name theme: `default`, `nature`, `space`, `minimal`, `custom` | `"default"` |
| `nameWords` | Custom theme words: `{ adjectives: [...], nouns: [...] }` | — |
| `feedRetention` | Max events kept in activity feed | `50` |
| `stuckThreshold` | Seconds of inactivity before stuck detection | `900` |
| `stuckNotify` | Show notification when a peer appears stuck | `true` |
| `autoStatus` | Auto-generate status messages from activity | `true` |
| `crewEventsInFeed` | Include crew task events in activity feed | `true` |
| `contextMode` | Context injection level: `full`, `minimal`, `none` | `"full"` |

Config priority: project `.pi/pi-messenger.json` > user `~/.pi/agent/pi-messenger.json` > `~/.pi/agent/settings.json` `"messenger"` key > defaults.

## How It Works

File-based coordination. No daemon. Dead agents detected via PID and cleaned up automatically.

```
~/.pi/agent/messenger/           # Shared across all projects
├── registry/                    # Agent registrations (PID, cwd, model, activity, tokens)
├── inbox/                       # Message delivery (one directory per agent)
├── feed.jsonl                   # Activity feed (append-only, pruned on startup)
├── claims.json                  # Swarm task claims
├── completions.json             # Completed swarm tasks
└── swarm.lock                   # Atomic lock for claims

.pi/messenger/crew/              # Per-project crew data
├── plan.json                    # Plan metadata (PRD path, progress)
├── plan.md                      # Planner output
├── planning-progress.md         # Planning loop history + reviewer feedback
├── tasks/                       # Task metadata (.json) and specs (.md)
├── blocks/                      # Block context for blocked tasks
├── artifacts/                   # Debug artifacts (input/output/jsonl per run)
└── config.json                  # Project-level crew config overrides
```

Activity tracking updates the registry every 10 seconds via debounced flushes. Messages are delivered via file watcher on the inbox directory.

## Credits

- **[mcp_agent_mail](https://github.com/Dicklesworthstone/mcp_agent_mail)** by [@doodlestein](https://x.com/doodlestein) — Inspiration for agent-to-agent messaging
- **[Pi coding agent](https://github.com/badlogic/pi-mono/)** by [@badlogicgames](https://x.com/badlogicgames)

## License

MIT
