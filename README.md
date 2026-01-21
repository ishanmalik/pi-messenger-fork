<p>
  <img src="banner.png" alt="pi-messenger" width="1100">
</p>

# Pi Messenger

**Multi-agent coordination for pi. No daemon, no server, just files.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-macOS%20%7C%20Linux-blue?style=for-the-badge)]()

```typescript
pi_messenger({ to: "GoldFalcon", message: "Done with auth, it's yours" })
pi_messenger({ reserve: ["src/auth/"], reason: "Refactoring" })
```

## Why

Running multiple pi instances on the same codebase leads to chaos. One agent rewrites a file while another is mid-edit. Neither knows the other exists.

Pi Messenger fixes this with three primitives:

**Discovery** - Agents register with memorable names (SwiftRaven, IronKnight) when they join the mesh. See who's active, what they're working on, which model they're using, and which git branch they're on.

**Messaging** - Send messages between agents. Recipients wake up immediately (even if idle) and see the message as a steering prompt. Coordinate handoffs, ask questions, broadcast status.

**File Reservations** - Claim files or directories. Other agents get blocked with a clear message telling them who to coordinate with. Auto-releases when you exit.

## Comparison

| Feature | Pi Messenger | Shared Context Files | Manual Coordination |
|---------|--------------|---------------------|---------------------|
| Agent discovery | Automatic | Manual | None |
| Real-time messaging | Yes (file watcher) | No | Chat app |
| File conflict prevention | Reservations | Hope | Yelling |
| Setup required | None | Write conventions | Write conventions |
| Daemon/server | No | No | No |

## Install

Already in your extensions directory. Restart pi to activate:

```
~/.pi/agent/extensions/pi-messenger/
```

After joining the mesh, your agent name appears in the status bar:

```
msg: SwiftRaven (2 peers) ●3
```

## Quick Start

```typescript
// Join the agent mesh (required before other operations)
pi_messenger({ join: true })
// → "Joined as SwiftRaven in backend on main. 2 peers active."

// Check your status
pi_messenger({})

// List active agents
pi_messenger({ list: true })

// Send a message
pi_messenger({ to: "GoldFalcon", message: "Auth module ready for review" })

// Broadcast to all
pi_messenger({ broadcast: true, message: "Taking the API routes" })

// Reserve files
pi_messenger({ reserve: ["src/auth/"], reason: "Refactoring" })

// Release when done
pi_messenger({ release: true })
```

**Note:** The `/messenger` command auto-joins when opened.

## Features

### Adaptive Agent Display

Output adapts based on where agents are working:

| Context | Display |
|---------|---------|
| Same folder + branch | Compact: name, model, time |
| Same folder, different branches | Adds branch per agent |
| Different folders | Adds folder per agent |

### File Reservation Enforcement

When another agent tries to edit reserved files:

```
src/auth/login.ts
Reserved by: SwiftRaven (in backend on main)
Reason: "Refactoring authentication"

Coordinate via pi_messenger({ to: "SwiftRaven", message: "..." })
```

### Immediate Message Delivery

Recipients see messages instantly, even if idle. Messages arrive as steering prompts that wake the agent:

```
**Message from SwiftRaven** — reply: pi_messenger({ to: "SwiftRaven", message: "..." })

Auth module is ready for review
```

### Chat Overlay

`/messenger` opens an interactive chat UI:

```
╭─ Messenger ── SwiftRaven ── 2 peers ────────────────╮
│ ▸ ● GoldFalcon │ ● IronKnight (1) │ + All           │
│─────────────────────────────────────────────────────│
│                                                     │
│  ┌─ GoldFalcon ─────────────────────── 10m ago ─┐   │
│  │ Hey, I'm starting on the API endpoints       │   │
│  └──────────────────────────────────────────────┘   │
│                                                     │
│  ┌─ You ────────────────────────────── 5m ago ──┐   │
│  │ Sounds good, I'll handle auth then           │   │
│  └──────────────────────────────────────────────┘   │
│                                                     │
│─────────────────────────────────────────────────────│
│ > Type message...                    [Tab] [Enter]  │
╰─────────────────────────────────────────────────────╯
```

## Keys

| Key | Action |
|-----|--------|
| `Tab` / `←` `→` | Switch agent tabs |
| `↑` `↓` | Scroll message history |
| `Home` / `End` | Jump to oldest / newest |
| `Enter` | Send message |
| `Esc` | Close overlay |

## Tool Reference

```typescript
pi_messenger({
  // Registration
  join?: boolean,              // Join the agent mesh (required first)

  // Messaging
  to?: string | string[],      // Recipient(s)
  broadcast?: boolean,         // Send to all
  message?: string,            // Message text
  replyTo?: string,            // Message ID for threading

  // Reservations
  reserve?: string[],          // Paths (trailing / for directories)
  reason?: string,             // Why reserving
  release?: string[] | true,   // Release specific or all

  // Other
  rename?: string,             // Change your name
  list?: boolean,              // List active agents
})
```

**Mode priority:** `join` → `to/broadcast` → `reserve` → `release` → `rename` → `list` → status

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PI_AGENT_NAME` | Explicit name (fails if taken) | Auto-generated |
| `PI_MESSENGER_DIR` | Custom data directory | `~/.pi/agent/messenger` |

```bash
PI_AGENT_NAME=AuthWorker pi
PI_AGENT_NAME=APIWorker pi
```

### Config Files

Priority (highest to lowest):
1. `.pi/pi-messenger.json` (project)
2. `~/.pi/agent/pi-messenger.json` (global)
3. `~/.pi/agent/settings.json` → `"messenger"` key

```json
{
  "autoRegister": false,
  "contextMode": "full",
  "registrationContext": true,
  "replyHint": true,
  "senderDetailsOnFirstContact": true
}
```

| Setting | Description | Default |
|---------|-------------|---------|
| `autoRegister` | Join mesh on startup (old behavior) | `false` |
| `contextMode` | `"full"` / `"minimal"` / `"none"` | `"full"` |
| `registrationContext` | Orientation message on join | `true` |
| `replyHint` | Include reply syntax in messages | `true` |
| `senderDetailsOnFirstContact` | Show sender's cwd/model first time | `true` |

## How It Works

```
~/.pi/agent/messenger/
├── registry/
│   ├── SwiftRaven.json     # name, PID, cwd, model, branch, reservations
│   └── GoldFalcon.json
└── inbox/
    ├── SwiftRaven/         # incoming messages
    └── GoldFalcon/
```

**Registration** - Agents write JSON with PID, sessionId, cwd, model, git branch. Write-then-verify prevents race conditions. Dead PIDs detected and cleaned up.

**Messaging** - Sender writes to recipient's inbox. File watcher triggers immediate delivery as steering message.

**Reservations** - Stored in registration. Checked on `tool_call` events before file operations.

**Cleanup** - Clean exit deletes registration. Crash detection via PID check.

## Limitations

- **Same-machine only** - File-based, no network
- **Literal path matching** - `src/auth/` won't match `/absolute/path/src/auth/`
- **Brief rename window** - Messages during rename (ms) may be lost
- **No persistence** - Messages deleted after delivery

## License

MIT
