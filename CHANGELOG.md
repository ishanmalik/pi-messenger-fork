# Changelog

## 0.4.0 - 2026-01-21

### Changed

- **Opt-in registration** - Agents no longer auto-register on startup. Use `pi_messenger({ join: true })` to join the mesh, or open `/messenger` which auto-joins. This reduces context pollution for sessions that don't need multi-agent coordination.
- **New `autoRegister` config** - Set to `true` to restore the old auto-register-on-startup behavior.

### Fixed

- **Read operations no longer blocked by reservations** - Previously, reading reserved files was blocked. Now only `edit` and `write` operations are blocked, allowing agents to read files for context even when another agent has reserved them.

## 0.3.0 - 2026-01-21

### Added

- **Agent differentiation** - Agents are now easier to distinguish when multiple work in the same folder
- **Git branch detection** - Automatically detects and displays git branch (or short SHA for detached HEAD)
- **Adaptive display modes** - List and overlay views adapt based on agent context:
  - Same folder + branch: Compact view, branch in header
  - Same folder, different branches: Shows branch per agent
  - Different folders: Shows folder per agent
- **Location awareness** - Status command now shows `Location: folder (branch)`
- **Enhanced context** - Registration and first-contact messages include location info
- **Improved reservation display** - Uses 🔒 prefix, truncates long paths from the left preserving filename

### Changed

- Reservation conflict messages now show the blocking agent's location: `Reserved by: X (in folder on branch)`
- First contact message format: `*X is in folder on branch (model)*`
- Tab bar adapts: name only (same context), name:branch (different branches), name/folder (different folders)
- Status details object now includes `folder` and `gitBranch` for programmatic access

### Fixed

- **Agent identity detection** - When an agent quits and a new pi instance registers with the same name, recipients now correctly see first-contact details. Previously, `seenSenders` tracked names only; now it tracks `name -> sessionId` to detect identity changes.
- **Registration race condition** - Added write-then-verify check to prevent two agents from claiming the same name simultaneously. If another agent wins the race, auto-generated names retry with a fresh lookup; explicit names fail with a clear error.
- **Rename race condition** - Added write-then-verify check to `renameAgent()` to prevent two agents from renaming to the same name simultaneously. If verification fails, returns "race_lost" error and the agent keeps its old name.

### Performance

- **Cached filtered agents** - `getActiveAgents()` now caches filtered results per agent name, avoiding repeated array allocations on every call.
- **Memoized agent colors** - `agentColorCode()` now caches computed color codes, avoiding hash recalculation on every render.
- **Overlay render cache** - Sorted agent list is now cached within each render cycle, avoiding redundant sort operations.
- **Reduced redundant calls** - `formatRelativeTime()` result is now reused in message box rendering instead of being called twice.

### Documentation

- **README overhaul** - New banner image showing connected pi symbols, punchy tagline, license/platform badges, comparison table, organized features section, keyboard shortcuts table, and streamlined layout following reference README patterns.

## 0.2.1 - 2026-01-20

### Fixed

- **Performance: Agent registry caching** - `getActiveAgents()` now caches results for 1 second, dramatically reducing disk I/O. Previously, every keypress in the overlay and every tool_call for read/edit/write caused full registry scans.
- **Performance: Watcher debouncing** - File watcher events are now debounced with 50ms delay, coalescing rapid filesystem events into a single message processing call.
- **Stability: Message processing guard** - Concurrent calls to `processAllPendingMessages()` are now serialized to prevent race conditions when watcher events and turn_end overlap.
- **Stability: MessengerState type** - Added `watcherDebounceTimer` field for proper debounce timer management.

## 0.2.0 - 2026-01-20

### Added

- **Chat overlay** - `/messenger` now opens an interactive overlay instead of a menu. Full chat interface with tabs for each agent, message history, and an input bar at the bottom.
- **Message history** - Messages persist in memory for the session (up to 50 per conversation). Scroll through history with arrow keys.
- **Unread badges** - Status bar shows total unread count. Tab bar shows per-agent unread counts that clear when you switch to that tab.
- **Broadcast tab** - "+ All" tab for sending messages to all agents at once. Shows your outgoing broadcast history.
- **Agent colors** - Each agent name gets a consistent color based on a hash of their name. Makes it easy to distinguish agents in conversations.
- **Agent details** - When viewing a conversation with no messages, shows the agent's working directory, model, and file reservations.
- **Context injection** - Agents now receive orientation on startup and helpful context with messages:
  - Registration message explaining multi-agent environment (once per session)
  - Reply hint showing how to respond to messages
  - Sender details (cwd, model) on first contact from each agent
- **Configuration file** - `~/.pi/agent/pi-messenger.json` for customizing context injection. Supports `contextMode: "full" | "minimal" | "none"`.

### Changed

- `/messenger` command now opens overlay (was: interactive menu with select prompts)
- Status bar now shows unread count badge when messages are waiting

### Fixed

- Message delivery order: files are now deleted after successful delivery, not before (prevents message loss if delivery fails)
- ANSI escape codes in message text are now stripped to prevent terminal injection
- Watcher recovery: if the inbox watcher dies after exhausting retries, it now automatically recovers on the next turn or session event
- Small terminal handling: overlay now handles very small terminal windows gracefully with minimum height safeguards

## 0.1.0 - 2026-01-20

Initial release.

- Agent discovery with auto-generated memorable names (SwiftRaven, GoldFalcon, etc.)
- Direct messaging between agents with immediate delivery
- Broadcast messaging to all active agents
- File reservations with conflict detection
- Message renderer for incoming agent messages
- Status bar integration showing agent name and peer count
