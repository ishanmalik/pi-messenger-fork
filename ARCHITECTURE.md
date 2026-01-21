# Pi Messenger Architecture

Visual guide to the internals of pi-messenger.

## System Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              PI MESSENGER                                    │
│                                                                             │
│   ┌─────────────┐    ┌─────────────┐    ┌─────────────┐    ┌─────────────┐ │
│   │   Agent A   │    │   Agent B   │    │   Agent C   │    │   Agent D   │ │
│   │ SwiftRaven  │    │ GoldFalcon  │    │ IronKnight  │    │  CalmBear   │ │
│   └──────┬──────┘    └──────┬──────┘    └──────┬──────┘    └──────┬──────┘ │
│          │                  │                  │                  │         │
│          └──────────────────┴──────────────────┴──────────────────┘         │
│                                     │                                        │
│                                     ▼                                        │
│          ┌──────────────────────────────────────────────────────┐           │
│          │              ~/.pi/agent/messenger/                   │           │
│          │  ┌────────────────────┐  ┌────────────────────┐      │           │
│          │  │     registry/      │  │       inbox/       │      │           │
│          │  │                    │  │                    │      │           │
│          │  │  SwiftRaven.json   │  │  SwiftRaven/       │      │           │
│          │  │  GoldFalcon.json   │  │  GoldFalcon/       │      │           │
│          │  │  IronKnight.json   │  │  IronKnight/       │      │           │
│          │  │  CalmBear.json     │  │  CalmBear/         │      │           │
│          │  └────────────────────┘  └────────────────────┘      │           │
│          └──────────────────────────────────────────────────────┘           │
│                                                                             │
│                         File-based coordination                             │
│                           No daemon required                                │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Module Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│    index.ts                        Entry point, event handlers, state       │
│    ═════════                                                                │
│         │                                                                   │
│         ├──────────────┬──────────────┬──────────────┬──────────────┐      │
│         ▼              ▼              ▼              ▼              ▼      │
│    ┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐    ┌────────┐ │
│    │config.ts│    │store.ts │    │handlers │    │overlay  │    │ lib.ts │ │
│    │         │    │         │    │   .ts   │    │   .ts   │    │        │ │
│    │ Config  │    │  File   │    │  Tool   │    │  Chat   │    │ Types  │ │
│    │ loading │    │   I/O   │    │handlers │    │   UI    │    │ Utils  │ │
│    └─────────┘    └────┬────┘    └────┬────┘    └────┬────┘    └────────┘ │
│                        │              │              │              ▲      │
│                        └──────────────┴──────────────┴──────────────┘      │
│                                       │                                     │
│                        store, handlers, overlay import lib.ts               │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘


    ┌──────────────────────────────────────────────────────────────────┐
    │                        Module Responsibilities                    │
    ├──────────────┬───────────────────────────────────────────────────┤
    │  lib.ts      │  Types, constants, pure utility functions         │
    │  config.ts   │  Load and merge configuration from 3 sources      │
    │  store.ts    │  Registry, inbox, watcher, file operations        │
    │  handlers.ts │  Tool execute functions (send, reserve, etc.)     │
    │  overlay.ts  │  Chat UI component for /messenger command         │
    │  index.ts    │  Extension setup, event handlers, state mgmt      │
    └──────────────┴───────────────────────────────────────────────────┘
```

## Agent Lifecycle

```
    ┌─────────────────────────────────────────────────────────────────┐
    │                        AGENT LIFECYCLE                          │
    └─────────────────────────────────────────────────────────────────┘

                              pi starts
                                  │
                                  ▼
                    ┌─────────────────────────┐
                    │     session_start       │
                    └────────────┬────────────┘
                                 │
                    ┌────────────▼────────────┐
                    │   config.autoRegister?  │
                    │                         │
                    │   No  → stay dormant    │
                    │         (tool available │
                    │          but inactive)  │
                    │                         │
                    │   Yes → continue ──────────┐
                    └─────────────────────────┘  │
                                                 │
                         ┌───────────────────────┘
                         │
                         │  (or user calls join: true / opens /messenger)
                         │
                    ┌────▼───────────────────┐
                    │   Generate/validate     │
                    │      agent name         │
                    │                         │
                    │  PI_AGENT_NAME set?     │
                    │    Yes → use it         │
                    │    No  → SwiftRaven     │
                    └────────────┬────────────┘
                                 │
                    ┌────────────▼────────────┐
                    │   Write registration    │
                    │                         │
                    │  registry/SwiftRaven.json│
                    │  {                      │
                    │    name, pid, sessionId,│
                    │    cwd, model, startedAt│
                    │    gitBranch            │
                    │  }                      │
                    └────────────┬────────────┘
                                 │
                    ┌────────────▼────────────┐
                    │   Write-then-verify     │
                    │   (race condition guard)│
                    │                         │
                    │   Read back, check PID  │
                    │   matches ours          │
                    └────────────┬────────────┘
                                 │
                    ┌────────────▼────────────┐
                    │   Create inbox dir      │
                    │   Start file watcher    │
                    └────────────┬────────────┘
                                 │
                                 ▼
    ┌ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┐
    │                     ACTIVE OPERATION                            │
    │                                                                 │
    │   • Respond to pi_messenger tool calls                         │
    │   • Watch inbox for incoming messages                          │
    │   • Process messages on turn_end                               │
    │   • Update reservations as needed                              │
    │   • Block conflicting file operations                          │
    │                                                                 │
    └ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┘
                                 │
                    ┌────────────▼────────────┐
                    │    session_shutdown     │
                    └────────────┬────────────┘
                                 │
                    ┌────────────▼────────────┐
                    │   Stop file watcher     │
                    │   Delete registration   │
                    └────────────┬────────────┘
                                 │
                                 ▼
                            pi exits
```

## Message Flow

```
    ┌─────────────────────────────────────────────────────────────────┐
    │                    MESSAGE DELIVERY FLOW                        │
    └─────────────────────────────────────────────────────────────────┘


         SENDER (SwiftRaven)                    RECIPIENT (GoldFalcon)
         ═══════════════════                    ══════════════════════

    ┌──────────────────────┐
    │  pi_messenger({      │
    │    to: "GoldFalcon", │
    │    message: "Hi!"    │
    │  })                  │
    └──────────┬───────────┘
               │
               ▼
    ┌──────────────────────┐
    │  Validate recipient  │
    │  • Name valid?       │
    │  • Registration?     │
    │  • PID alive?        │
    └──────────┬───────────┘
               │
               ▼
    ┌──────────────────────┐
    │  Write message file  │
    │                      │
    │  inbox/GoldFalcon/   │
    │    1705123456-x7k2.json
    └──────────┬───────────┘
               │
               │                         ┌──────────────────────┐
               └────────────────────────▶│   fs.watch detects   │
                                         │   new file           │
                                         └──────────┬───────────┘
                                                    │
                                                    ▼
                                         ┌──────────────────────┐
                                         │  Read message JSON   │
                                         │  Parse contents      │
                                         └──────────┬───────────┘
                                                    │
                                                    ▼
                                         ┌──────────────────────┐
                                         │  deliverMessage()    │
                                         │                      │
                                         │  • Store in history  │
                                         │  • Increment unread  │
                                         │  • Build content     │
                                         │  • Add reply hint    │
                                         └──────────┬───────────┘
                                                    │
                                                    ▼
                                         ┌──────────────────────┐
                                         │  pi.sendMessage()    │
                                         │                      │
                                         │  triggerTurn: true   │
                                         │  deliverAs: "steer"  │
                                         └──────────┬───────────┘
                                                    │
                                                    ▼
                                         ┌──────────────────────┐
                                         │  Delete message file │
                                         │  (after delivery)    │
                                         └──────────────────────┘


    ════════════════════════════════════════════════════════════════════

                           MESSAGE FILE FORMAT

    ════════════════════════════════════════════════════════════════════

                    inbox/GoldFalcon/1705123456-x7k2.json
                    ┌──────────────────────────────────┐
                    │ {                                │
                    │   "id": "uuid-...",              │
                    │   "from": "SwiftRaven",          │
                    │   "to": "GoldFalcon",            │
                    │   "text": "Hi!",                 │
                    │   "timestamp": "2026-01-...",    │
                    │   "replyTo": null                │
                    │ }                                │
                    └──────────────────────────────────┘
```

## File Watcher Recovery

```
    ┌─────────────────────────────────────────────────────────────────┐
    │                    WATCHER RETRY LOGIC                          │
    └─────────────────────────────────────────────────────────────────┘


                         startWatcher()
                              │
                              ▼
               ┌──────────────────────────────┐
               │   Guards (all must pass):    │
               │   • registered? yes          │
               │   • watcher exists? no       │
               │   • retries < 5? yes         │
               └──────────────┬───────────────┘
                              │
                              ▼
               ┌──────────────────────────────┐
               │   fs.watch(inbox, callback)  │
               └──────────────┬───────────────┘
                              │
              ┌───────────────┴───────────────┐
              │                               │
          SUCCESS                          FAILURE
              │                               │
              ▼                               ▼
    ┌──────────────────┐          ┌──────────────────────┐
    │ Reset retries: 0 │          │   scheduleRetry()    │
    │ Attach error     │          │                      │
    │ handler          │          │   retries++          │
    └──────────────────┘          │   delay = 2^n sec    │
                                  │   (max 30s)          │
                                  └──────────┬───────────┘
                                             │
                        ┌────────────────────┴────────────────────┐
                        │                                        │
                   retries < 5                              retries >= 5
                        │                                        │
                        ▼                                        ▼
            ┌───────────────────────┐                ┌───────────────────┐
            │  setTimeout(delay)    │                │   GIVE UP         │
            │  then startWatcher()  │                │   (dead watcher)  │
            └───────────────────────┘                └─────────┬─────────┘
                                                               │
                                                               │
    ════════════════════════════════════════════════════════════════════
                                                               │
                             RECOVERY (on turn_end, session events)
                                                               │
                                                               ▼
                                              ┌────────────────────────────┐
                                              │  recoverWatcherIfNeeded()  │
                                              │                            │
                                              │  if registered &&          │
                                              │     !watcher &&            │
                                              │     !retryTimer:           │
                                              │                            │
                                              │    retries = 0             │
                                              │    startWatcher()          │
                                              └────────────────────────────┘


    ┌───────────────────────────────────────────────────────────────────┐
    │                      RETRY TIMING                                 │
    ├───────────────────────────────────────────────────────────────────┤
    │                                                                   │
    │   Attempt 1: immediate                                            │
    │   Attempt 2: 1 second delay     (2^0 × 1000ms)                   │
    │   Attempt 3: 2 second delay     (2^1 × 1000ms)                   │
    │   Attempt 4: 4 second delay     (2^2 × 1000ms)                   │
    │   Attempt 5: 8 second delay     (2^3 × 1000ms)                   │
    │                                                                   │
    │   Then: wait for turn_end or session event to recover            │
    │                                                                   │
    └───────────────────────────────────────────────────────────────────┘
```

## Reservation System

```
    ┌─────────────────────────────────────────────────────────────────┐
    │                    FILE RESERVATION FLOW                        │
    └─────────────────────────────────────────────────────────────────┘


      Agent: SwiftRaven                           Agent: GoldFalcon
      ═════════════════                           ═════════════════

    ┌───────────────────────┐
    │  pi_messenger({       │
    │    reserve: ["src/auth/"],
    │    reason: "Refactoring"
    │  })                   │
    └───────────┬───────────┘
                │
                ▼
    ┌───────────────────────┐
    │  Update local state   │
    │  reservations[]       │
    └───────────┬───────────┘
                │
                ▼
    ┌───────────────────────┐
    │  Write to registry    │
    │                       │
    │  SwiftRaven.json:     │
    │  {                    │
    │    ...                │
    │    "reservations": [  │
    │      {                │
    │        "pattern":     │
    │          "src/auth/", │
    │        "reason":      │
    │          "Refactoring",
    │        "since": "..." │
    │      }                │
    │    ]                  │
    │  }                    │
    └───────────────────────┘

                                              ┌───────────────────────┐
                                              │  edit({               │
                                              │    path: "src/auth/   │
                                              │           login.ts"   │
                                              │  })                   │
                                              └───────────┬───────────┘
                                                          │
                                                          ▼
                                              ┌───────────────────────┐
                                              │  tool_call event      │
                                              │  triggers hook        │
                                              └───────────┬───────────┘
                                                          │
                                                          ▼
                                              ┌───────────────────────┐
                                              │  getConflictsWithOtherAgents()
                                              │                       │
                                              │  Read all registrations
                                              │  Check reservations   │
                                              │  Match path patterns  │
                                              └───────────┬───────────┘
                                                          │
                                                          ▼
                                              ┌───────────────────────┐
                                              │  CONFLICT DETECTED    │
                                              │                       │
                                              │  return {             │
                                              │    block: true,       │
                                              │    reason: "..."      │
                                              │  }                    │
                                              └───────────────────────┘

    ════════════════════════════════════════════════════════════════════

                         PATTERN MATCHING RULES

    ════════════════════════════════════════════════════════════════════

    ┌────────────────────────────────────────────────────────────────┐
    │                                                                │
    │   Pattern             File Path              Match?            │
    │   ───────             ─────────              ──────            │
    │   src/auth/           src/auth/login.ts      ✓ Yes            │
    │   src/auth/           src/auth/              ✓ Yes            │
    │   src/auth/           src/authentication/    ✗ No             │
    │   config.yaml         config.yaml            ✓ Yes            │
    │   config.yaml         config.yml             ✗ No             │
    │                                                                │
    │   Note: Trailing "/" indicates directory reservation          │
    │                                                                │
    └────────────────────────────────────────────────────────────────┘
```

## Configuration Cascade

```
    ┌─────────────────────────────────────────────────────────────────┐
    │                    CONFIGURATION PRIORITY                       │
    └─────────────────────────────────────────────────────────────────┘


                          loadConfig(cwd)
                               │
         ┌─────────────────────┼─────────────────────┐
         │                     │                     │
         ▼                     ▼                     ▼
    ┌─────────┐          ┌─────────┐          ┌─────────┐
    │ PROJECT │          │EXTENSION│          │SETTINGS │
    │(highest)│          │ GLOBAL  │          │(lowest) │
    └────┬────┘          └────┬────┘          └────┬────┘
         │                    │                    │
         │                    │                    │
    .pi/pi-messenger.json     │         ~/.pi/agent/settings.json
         │                    │                    │
         │       ~/.pi/agent/pi-messenger.json     │
         │                    │                    │
         └────────────────────┼────────────────────┘
                              │
                              ▼
                    ┌──────────────────┐
                    │      MERGE       │
                    │                  │
                    │  defaults        │
                    │    ↓             │
                    │  settings.json   │
                    │    ↓             │
                    │  extension.json  │
                    │    ↓             │
                    │  project.json    │
                    └────────┬─────────┘
                             │
                             ▼
                    ┌──────────────────┐
                    │  Apply shortcuts │
                    │                  │
                    │  "none" →        │
                    │    all false     │
                    │                  │
                    │  "minimal" →     │
                    │    replyHint     │
                    │    only          │
                    │                  │
                    │  "full" →        │
                    │    use merged    │
                    │    values        │
                    └────────┬─────────┘
                             │
                             ▼
                    ┌──────────────────┐
                    │  Final Config    │
                    │                  │
                    │ {                │
                    │   contextMode,   │
                    │   registration   │
                    │     Context,     │
                    │   replyHint,     │
                    │   senderDetails  │
                    │     OnFirst      │
                    │     Contact      │
                    │ }                │
                    └──────────────────┘
```

## Event Flow

```
    ┌─────────────────────────────────────────────────────────────────┐
    │                      PI EVENT HANDLERS                          │
    └─────────────────────────────────────────────────────────────────┘


    ┌──────────────────┐
    │   session_start  │───────▶  (only if config.autoRegister)
    └──────────────────┘                    │
                                            ▼
                               register() → startWatcher() → updateStatus()
                                            │
                                            ▼
                                Send registration context
                                (if config.registrationContext)


    ┌──────────────────┐
    │  session_switch  │───────▶  recoverWatcherIfNeeded() → updateStatus()
    └──────────────────┘


    ┌──────────────────┐
    │   session_fork   │───────▶  recoverWatcherIfNeeded() → updateStatus()
    └──────────────────┘


    ┌──────────────────┐
    │   session_tree   │───────▶  updateStatus()
    └──────────────────┘


    ┌──────────────────┐
    │    turn_end      │───────▶  processAllPendingMessages()
    └──────────────────┘                     │
                                             ▼
                                  recoverWatcherIfNeeded()
                                             │
                                             ▼
                                       updateStatus()


    ┌──────────────────┐
    │session_shutdown  │───────▶  stopWatcher() → unregister()
    └──────────────────┘


    ┌──────────────────┐         ┌────────────────────────────┐
    │    tool_call     │───────▶ │  Is tool read/edit/write?  │
    └──────────────────┘         └─────────────┬──────────────┘
                                               │
                                    ┌──────────┴──────────┐
                                    │                     │
                                   Yes                    No
                                    │                     │
                                    ▼                     ▼
                         ┌──────────────────┐        (no action)
                         │ Check conflicts  │
                         └────────┬─────────┘
                                  │
                         ┌────────┴────────┐
                         │                 │
                      Conflict          No conflict
                         │                 │
                         ▼                 ▼
                    Block with         (allow)
                    reason
```

## Chat Overlay Structure

```
    ┌─────────────────────────────────────────────────────────────────┐
    │                      OVERLAY LAYOUT                             │
    └─────────────────────────────────────────────────────────────────┘


    ╭─────────────────────────────────────────────────────────────────╮
    │                                                                 │
    │   Messenger ── SwiftRaven ── 2 peers            ← Title Bar    │
    │                                                                 │
    │   ▸ ● GoldFalcon │ ● IronKnight (3) │ + All     ← Tab Bar      │
    │   ─────────────────────────────────────────────                 │
    │                                                                 │
    │                        Message Area                             │
    │                                                                 │
    │     ┌─ GoldFalcon ──────────────────────── 10m ago ─┐          │
    │     │ Hey, starting on API endpoints                │          │
    │     └───────────────────────────────────────────────┘          │
    │                                                                 │
    │     ┌─ You ─────────────────────────────── 5m ago ──┐          │
    │     │ Sounds good, I'll handle auth                 │          │
    │     └───────────────────────────────────────────────┘          │
    │                                                                 │
    │   ─────────────────────────────────────────────                 │
    │   > Type message here...                [Tab] [Enter]← Input   │
    │                                                                 │
    ╰─────────────────────────────────────────────────────────────────╯


    ┌───────────────────────────────────────────────────────────────┐
    │                      KEYBOARD CONTROLS                        │
    ├───────────────────────────────────────────────────────────────┤
    │                                                               │
    │   Tab / → / ←      Cycle between agent tabs                  │
    │   ↑ / ↓            Scroll message history                    │
    │   Home / End       Jump to oldest / newest                   │
    │   Enter            Send message                              │
    │   Backspace        Delete character                          │
    │   Esc              Close overlay                             │
    │                                                               │
    └───────────────────────────────────────────────────────────────┘


    ┌───────────────────────────────────────────────────────────────┐
    │                      STATE MANAGEMENT                         │
    ├───────────────────────────────────────────────────────────────┤
    │                                                               │
    │   selectedAgent     Currently selected tab (or null for All) │
    │   inputText         Current input buffer                     │
    │   scrollPosition    Messages scrolled from bottom (0=newest) │
    │                                                               │
    │   On tab switch:    Clear unread count, reset scroll         │
    │   On send success:  Clear input, reset scroll                │
    │   On send failure:  Keep input (retry possible)              │
    │                                                               │
    └───────────────────────────────────────────────────────────────┘
```

## Data Structures

```
    ┌─────────────────────────────────────────────────────────────────┐
    │                      CORE DATA TYPES                            │
    └─────────────────────────────────────────────────────────────────┘


    MessengerState                          In-memory runtime state
    ══════════════                          ═══════════════════════

    ┌────────────────────────────────────────────────────────────────┐
    │                                                                │
    │   agentName: string              "SwiftRaven"                  │
    │   registered: boolean            true                          │
    │   gitBranch: string | undefined  "main"                        │
    │   watcher: FSWatcher | null      <watching inbox>              │
    │   watcherRetries: number         0                             │
    │   watcherRetryTimer: Timer       null                          │
    │   watcherDebounceTimer: Timer    null                          │
    │   reservations: FileReservation[]                              │
    │   │                                                            │
    │   │   ┌─────────────────────────────────────────────┐          │
    │   └──▶│ { pattern: "src/auth/", reason: "...", ... }│          │
    │       └─────────────────────────────────────────────┘          │
    │                                                                │
    │   chatHistory: Map<string, AgentMailMessage[]>                 │
    │   │                                                            │
    │   │   "GoldFalcon" ──▶ [ msg1, msg2, msg3, ... ]               │
    │   │   "IronKnight" ──▶ [ msg1, msg2, ... ]                     │
    │   │                                                            │
    │   unreadCounts: Map<string, number>                            │
    │   │                                                            │
    │   │   "GoldFalcon" ──▶ 0                                       │
    │   │   "IronKnight" ──▶ 3                                       │
    │   │                                                            │
    │   broadcastHistory: AgentMailMessage[]                         │
    │   │                                                            │
    │   │   [ broadcast1, broadcast2, ... ]                          │
    │   │                                                            │
    │   seenSenders: Map<string, string>   (name -> sessionId)       │
    │   │                                                            │
    │   │   "GoldFalcon" ──▶ "session-abc"  (detects agent restart) │
    │   │   "IronKnight" ──▶ "session-xyz"                          │
    │                                                                │
    └────────────────────────────────────────────────────────────────┘


    AgentRegistration                       Persisted to registry/
    ═════════════════                       ═══════════════════════

    ┌────────────────────────────────────────────────────────────────┐
    │  {                                                             │
    │    "name": "SwiftRaven",                                       │
    │    "pid": 12345,                                               │
    │    "sessionId": "abc-123",                                     │
    │    "cwd": "/Users/dev/project",                                │
    │    "model": "claude-sonnet-4",                                 │
    │    "startedAt": "2026-01-20T10:30:00.000Z",                    │
    │    "gitBranch": "main",                                        │
    │    "reservations": [                                           │
    │      {                                                         │
    │        "pattern": "src/auth/",                                 │
    │        "reason": "Refactoring authentication",                 │
    │        "since": "2026-01-20T10:35:00.000Z"                     │
    │      }                                                         │
    │    ]                                                           │
    │  }                                                             │
    └────────────────────────────────────────────────────────────────┘


    AgentMailMessage                        Transient message file
    ════════════════                        ══════════════════════

    ┌────────────────────────────────────────────────────────────────┐
    │  {                                                             │
    │    "id": "550e8400-e29b-41d4-a716-446655440000",               │
    │    "from": "SwiftRaven",                                       │
    │    "to": "GoldFalcon",                                         │
    │    "text": "Auth module is ready for review",                  │
    │    "timestamp": "2026-01-20T10:45:00.000Z",                    │
    │    "replyTo": null                                             │
    │  }                                                             │
    └────────────────────────────────────────────────────────────────┘
```

## Broadcast Flow

```
    ┌─────────────────────────────────────────────────────────────────┐
    │                      BROADCAST MESSAGE                          │
    └─────────────────────────────────────────────────────────────────┘


                            SwiftRaven
                                │
                                │  pi_messenger({
                                │    broadcast: true,
                                │    message: "Sync up!"
                                │  })
                                │
                                ▼
                    ┌───────────────────────┐
                    │   Get active agents   │
                    │   [GoldFalcon,        │
                    │    IronKnight,        │
                    │    CalmBear]          │
                    └───────────┬───────────┘
                                │
            ┌───────────────────┼───────────────────┐
            │                   │                   │
            ▼                   ▼                   ▼
    ┌───────────────┐   ┌───────────────┐   ┌───────────────┐
    │  Write to     │   │  Write to     │   │  Write to     │
    │  GoldFalcon/  │   │  IronKnight/  │   │  CalmBear/    │
    │  inbox        │   │  inbox        │   │  inbox        │
    └───────┬───────┘   └───────┬───────┘   └───────┬───────┘
            │                   │                   │
            │                   │                   │
     ┌──────┴──────┐     ┌──────┴──────┐     ┌──────┴──────┐
     │   Success   │     │   Success   │     │   Failure   │
     └─────────────┘     └─────────────┘     └─────────────┘
                                │
                                │  Best-effort: failures
                                │  don't stop others
                                │
                                ▼
                    ┌───────────────────────┐
                    │  Store in local       │
                    │  broadcastHistory     │
                    │  (regardless of       │
                    │   individual fails)   │
                    └───────────────────────┘


    ════════════════════════════════════════════════════════════════════

                      BROADCAST VS DIRECT MESSAGE

    ════════════════════════════════════════════════════════════════════

    ┌─────────────────────────────┬─────────────────────────────────────┐
    │         DIRECT              │           BROADCAST                 │
    ├─────────────────────────────┼─────────────────────────────────────┤
    │                             │                                     │
    │  to: "GoldFalcon"           │  broadcast: true                    │
    │                             │                                     │
    │  Validated before send      │  Best-effort to all                 │
    │                             │                                     │
    │  Failure = error returned   │  Individual failures ignored        │
    │                             │                                     │
    │  Stored in chatHistory      │  Stored in broadcastHistory         │
    │  keyed by recipient         │  with to: "broadcast"               │
    │                             │                                     │
    │  Shows in recipient's tab   │  Shows in "+ All" tab               │
    │                             │                                     │
    └─────────────────────────────┴─────────────────────────────────────┘
```

## Name Generation

```
    ┌─────────────────────────────────────────────────────────────────┐
    │                    MEMORABLE NAME GENERATION                    │
    └─────────────────────────────────────────────────────────────────┘


                         generateMemorableName()
                                  │
                    ┌─────────────┴─────────────┐
                    │                           │
                    ▼                           ▼
            ┌─────────────┐             ┌─────────────┐
            │ ADJECTIVES  │             │   NOUNS     │
            │ (25 words)  │             │ (26 words)  │
            ├─────────────┤             ├─────────────┤
            │ Swift       │             │ Arrow       │
            │ Bright      │             │ Bear        │
            │ Calm        │             │ Castle      │
            │ Dark        │             │ Dragon      │
            │ Epic        │             │ Eagle       │
            │ Fast        │             │ Falcon      │
            │ Gold        │             │ Grove       │
            │ Happy       │             │ Hawk        │
            │ Iron        │             │ Ice         │
            │ Jade        │             │ Jaguar      │
            │ Keen        │             │ Knight      │
            │ Loud        │             │ Lion        │
            │ Mint        │             │ Moon        │
            │ Nice        │             │ Nova        │
            │ Oak         │             │ Owl         │
            │ Pure        │             │ Phoenix     │
            │ Quick       │             │ Quartz      │
            │ Red         │             │ Raven       │
            │ Sage        │             │ Storm       │
            │ True        │             │ Tiger       │
            │ Ultra       │             │ Union       │
            │ Vivid       │             │ Viper       │
            │ Wild        │             │ Wolf        │
            │ Young       │             │ Xenon       │
            │ Zen         │             │ Yak         │
            └──────┬──────┘             │ Zenith      │
                   │                    └──────┬──────┘
                   │                           │
                   └───────────┬───────────────┘
                               │
                               ▼
                        ┌─────────────┐
                        │   COMBINE   │
                        │             │
                        │  Adjective  │
                        │      +      │
                        │    Noun     │
                        └──────┬──────┘
                               │
                               ▼
                        ┌─────────────┐
                        │ SwiftRaven  │
                        │ GoldFalcon  │
                        │ IronKnight  │
                        │ CalmBear    │
                        │    ...      │
                        └─────────────┘

                    25 × 26 = 650 possible combinations


    ════════════════════════════════════════════════════════════════════

                         NAME COLLISION HANDLING

    ════════════════════════════════════════════════════════════════════

                         findAvailableName("SwiftRaven")
                                     │
                                     ▼
                    ┌────────────────────────────────┐
                    │  SwiftRaven.json exists?       │
                    └────────────────┬───────────────┘
                                     │
                          ┌──────────┴──────────┐
                          │                     │
                         No                    Yes
                          │                     │
                          ▼                     ▼
                  Return "SwiftRaven"   Is PID alive?
                                               │
                                    ┌──────────┴──────────┐
                                    │                     │
                                   No                    Yes
                                    │                     │
                                    ▼                     ▼
                            Return "SwiftRaven"   Try "SwiftRaven2"
                            (overwrite stale)            │
                                                         ▼
                                                  Try "SwiftRaven3"
                                                         │
                                                         ▼
                                                       ...
                                                         │
                                                         ▼
                                                  Try "SwiftRaven99"
                                                         │
                                                         ▼
                                                  Return null (give up)


    ════════════════════════════════════════════════════════════════════

                    REGISTRATION RACE CONDITION (v0.3.0)

    ════════════════════════════════════════════════════════════════════

      Two agents try to claim "SwiftRaven" simultaneously:

         Agent A                                    Agent B
            │                                          │
            ▼                                          ▼
    Check: available ◀───────────────────────▶ Check: available
            │                                          │
            ▼                                          ▼
    Write SwiftRaven.json                      Write SwiftRaven.json
            │                                          │  (overwrites A!)
            ▼                                          ▼
    Verify: read back ◀─────── B's PID ───────▶ Verify: read back
            │                                          │
            ▼                                          ▼
    PID mismatch!                               PID matches!
    (our write was                              SUCCESS
     overwritten)                                  │
            │                                      ▼
            ▼                                  Agent B is
    Retry with fresh                          "SwiftRaven"
    findAvailableName()
            │
            ▼
    Now sees "SwiftRaven"
    is taken, returns
    "SwiftRaven2"
            │
            ▼
    Agent A becomes
    "SwiftRaven2"


    Auto-generated names: retry up to 3 times
    Explicit names (PI_AGENT_NAME): fail with error
```

## Performance Optimizations

```
    ┌─────────────────────────────────────────────────────────────────┐
    │                    AGENTS CACHE (v0.2.1)                        │
    └─────────────────────────────────────────────────────────────────┘


                         getActiveAgents()
                               │
                               ▼
               ┌───────────────────────────────┐
               │   Cache valid?                │
               │   • exists?                   │
               │   • same registry path?       │
               │   • age < 1 second?           │
               └───────────────┬───────────────┘
                               │
                    ┌──────────┴──────────┐
                    │                     │
                   Yes                    No
                    │                     │
                    ▼                     ▼
           ┌──────────────┐      ┌──────────────────┐
           │ Return cached│      │ Read from disk   │
           │ (filter self)│      │ (full scan)      │
           └──────────────┘      └────────┬─────────┘
                                          │
                                          ▼
                                 ┌──────────────────┐
                                 │ Update cache     │
                                 │ timestamp        │
                                 └────────┬─────────┘
                                          │
                                          ▼
                                 ┌──────────────────┐
                                 │ Return filtered  │
                                 │ (exclude self)   │
                                 └──────────────────┘


    Cache invalidated after: register(), unregister(), renameAgent()


    ┌─────────────────────────────────────────────────────────────────┐
    │                   WATCHER DEBOUNCE (v0.2.1)                     │
    └─────────────────────────────────────────────────────────────────┘


         fs.watch event                    fs.watch event
              │                                  │
              ▼                                  ▼
       ┌────────────┐                     ┌────────────┐
       │ Clear any  │                     │ Clear any  │
       │ pending    │                     │ pending    │
       │ timer      │                     │ timer      │
       └─────┬──────┘                     └─────┬──────┘
             │                                  │
             ▼                                  ▼
       ┌────────────┐                     ┌────────────┐
       │ Set 50ms   │                     │ Set 50ms   │
       │ timer      │ ─────────────────── │ timer      │
       └─────┬──────┘   (timer reset)     └─────┬──────┘
             │                                  │
             │                                  ▼
             │                           ┌────────────┐
             │                           │ Timer      │
             │                           │ expires    │
             │                           └─────┬──────┘
             │                                 │
             │                                 ▼
             │                    ┌────────────────────────┐
             │                    │ processAllPendingMessages()
             │                    └────────────────────────┘
             │
             ▼
       (cancelled - never fires)


    ┌─────────────────────────────────────────────────────────────────┐
    │                  PROCESSING GUARD (v0.2.1)                      │
    └─────────────────────────────────────────────────────────────────┘


       Call 1                              Call 2 (while 1 running)
          │                                       │
          ▼                                       ▼
    ┌───────────┐                          ┌───────────┐
    │ Is        │                          │ Is        │
    │ processing│ ─── No ───┐              │ processing│ ─── Yes ──┐
    │ ?         │           │              │ ?         │           │
    └───────────┘           │              └───────────┘           │
                            ▼                                      ▼
                   ┌─────────────────┐                   ┌─────────────────┐
                   │ Set processing  │                   │ Store args in   │
                   │ = true          │                   │ pendingProcessArgs
                   └────────┬────────┘                   └────────┬────────┘
                            │                                     │
                            ▼                                     ▼
                   ┌─────────────────┐                       (return)
                   │ Process all     │
                   │ messages        │
                   └────────┬────────┘
                            │
                            ▼
                   ┌─────────────────┐
                   │ Set processing  │
                   │ = false         │
                   └────────┬────────┘
                            │
                            ▼
                   ┌─────────────────┐
                   │ Check pending?  │ ─── Yes ──▶ Re-run with stored args
                   └────────┬────────┘
                            │
                           No
                            │
                            ▼
                        (done)
```

---

*These diagrams represent the architecture as of v0.3.0*
