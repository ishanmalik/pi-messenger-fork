/**
 * Pi Messenger Extension
 *
 * Enables pi agents to discover and communicate with each other across terminal sessions.
 * Uses file-based coordination - no daemon required.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { TUI } from "@mariozechner/pi-tui";
import { truncateToWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import {
  type MessengerState,
  type Dirs,
  type AgentMailMessage,
  MAX_CHAT_HISTORY,
  formatRelativeTime,
  stripAnsiCodes,
  extractFolder,
} from "./lib.js";
import * as store from "./store.js";
import * as handlers from "./handlers.js";
import { MessengerOverlay } from "./overlay.js";
import { loadConfig, type MessengerConfig } from "./config.js";

let overlayTui: TUI | null = null;

export default function piMessengerExtension(pi: ExtensionAPI) {
  // ===========================================================================
  // State & Configuration
  // ===========================================================================

  const config: MessengerConfig = loadConfig(process.cwd());

  const state: MessengerState = {
    agentName: process.env.PI_AGENT_NAME || "",
    registered: false,
    watcher: null,
    watcherRetries: 0,
    watcherRetryTimer: null,
    watcherDebounceTimer: null,
    reservations: [],
    chatHistory: new Map(),
    unreadCounts: new Map(),
    broadcastHistory: [],
    seenSenders: new Map(),
    gitBranch: undefined
  };

  const baseDir = process.env.PI_MESSENGER_DIR || join(homedir(), ".pi/agent/messenger");
  const dirs: Dirs = {
    base: baseDir,
    registry: join(baseDir, "registry"),
    inbox: join(baseDir, "inbox")
  };

  // ===========================================================================
  // Message Delivery
  // ===========================================================================

  function deliverMessage(msg: AgentMailMessage): void {
    // Store in chat history (keyed by sender)
    let history = state.chatHistory.get(msg.from);
    if (!history) {
      history = [];
      state.chatHistory.set(msg.from, history);
    }
    history.push(msg);
    if (history.length > MAX_CHAT_HISTORY) history.shift();

    // Increment unread count
    const current = state.unreadCounts.get(msg.from) ?? 0;
    state.unreadCounts.set(msg.from, current + 1);

    // Trigger overlay re-render if open
    overlayTui?.requestRender();

    // Build message content with optional context
    // Detect if this is a new agent identity (first contact OR same name but different session)
    const sender = store.getActiveAgents(state, dirs).find(a => a.name === msg.from);
    const senderSessionId = sender?.sessionId;
    const prevSessionId = state.seenSenders.get(msg.from);
    const isNewIdentity = !prevSessionId || (senderSessionId && prevSessionId !== senderSessionId);

    // Update seen senders with current sessionId (only if we could look it up)
    if (senderSessionId) {
      state.seenSenders.set(msg.from, senderSessionId);
    }

    let content = "";

    // Add sender details on new identity (first contact or agent restart with same name)
    if (isNewIdentity && config.senderDetailsOnFirstContact && sender) {
      const folder = extractFolder(sender.cwd);
      const locationPart = sender.gitBranch
        ? `${folder} on ${sender.gitBranch}`
        : folder;
      content += `*${msg.from} is in ${locationPart} (${sender.model})*\n\n`;
    }

    // Add reply hint
    const replyHint = config.replyHint
      ? ` — reply: pi_messenger({ to: "${msg.from}", message: "..." })`
      : "";

    content += `**Message from ${msg.from}**${replyHint}\n\n${msg.text}`;

    if (msg.replyTo) {
      content = `*(reply to ${msg.replyTo.substring(0, 8)})*\n\n${content}`;
    }

    pi.sendMessage(
      { customType: "agent_message", content, display: true, details: msg },
      { triggerTurn: true, deliverAs: "steer" }
    );
  }

  // ===========================================================================
  // Status
  // ===========================================================================

  function updateStatus(ctx: ExtensionContext): void {
    if (!ctx.hasUI || !state.registered) return;

    const agents = store.getActiveAgents(state, dirs);
    const activeNames = new Set(agents.map(a => a.name));
    const count = agents.length;
    const theme = ctx.ui.theme;

    // Clear unread counts for agents that are no longer active
    for (const name of state.unreadCounts.keys()) {
      if (!activeNames.has(name)) {
        state.unreadCounts.delete(name);
      }
    }

    // Sum remaining unread counts
    let totalUnread = 0;
    for (const n of state.unreadCounts.values()) totalUnread += n;

    const nameStr = theme.fg("accent", state.agentName);
    const countStr = theme.fg("dim", ` (${count} peer${count === 1 ? "" : "s"})`);
    const unreadStr = totalUnread > 0 ? theme.fg("accent", ` ●${totalUnread}`) : "";

    ctx.ui.setStatus("messenger", `msg: ${nameStr}${countStr}${unreadStr}`);
  }

  // ===========================================================================
  // Tool Registration
  // ===========================================================================

  pi.registerTool({
    name: "pi_messenger",
    label: "Pi Messenger",
    description: `Communicate with other pi agents and manage file reservations.

Usage:
  pi_messenger({ join: true })                   → Join the agent mesh (required before other operations)
  pi_messenger({ })                              → Status (your name, peers, your reservations)
  pi_messenger({ list: true })                   → List other agents with their reservations
  pi_messenger({ to: "Name", message: "hi" })    → Send message to one agent
  pi_messenger({ to: ["A", "B"], message: "..." })  → Send to multiple agents
  pi_messenger({ broadcast: true, message: "..." }) → Send to ALL active agents
  pi_messenger({ reserve: ["src/auth/"] })       → Reserve files (trailing slash for directories)
  pi_messenger({ release: ["src/auth/"] })       → Release specific reservations
  pi_messenger({ release: true })                → Release all your reservations
  pi_messenger({ rename: "NewName" })            → Rename yourself

Mode: join > to/broadcast (send) > reserve > release > rename > list > status`,
    parameters: Type.Object({
      join: Type.Optional(Type.Boolean({ description: "Join the agent mesh" })),
      to: Type.Optional(Type.Union([
        Type.String({ description: "Target agent name" }),
        Type.Array(Type.String(), { description: "Multiple target agent names" })
      ])),
      broadcast: Type.Optional(Type.Boolean({ description: "Send to all active agents" })),
      message: Type.Optional(Type.String({ description: "Message to send" })),
      replyTo: Type.Optional(Type.String({ description: "Message ID if this is a reply" })),
      reserve: Type.Optional(Type.Array(Type.String(), { description: "Paths to reserve" })),
      reason: Type.Optional(Type.String({ description: "Reason for reservation" })),
      release: Type.Optional(Type.Union([
        Type.Array(Type.String(), { description: "Patterns to release" }),
        Type.Boolean({ description: "true to release all" })
      ])),
      rename: Type.Optional(Type.String({ description: "Rename yourself to a new name" })),
      list: Type.Optional(Type.Boolean({ description: "List other agents" }))
    }),

    async execute(_toolCallId, params: {
      join?: boolean;
      to?: string | string[];
      broadcast?: boolean;
      message?: string;
      replyTo?: string;
      reserve?: string[];
      reason?: string;
      release?: string[] | boolean;
      rename?: string;
      list?: boolean;
    }, _onUpdate, ctx, _signal) {
      const { join, to, broadcast, message, replyTo, reserve, reason, release, rename, list } = params;

      // Join doesn't require registration
      if (join) {
        const joinResult = handlers.executeJoin(state, dirs, ctx, deliverMessage, updateStatus);
        
        // Send registration context after successful join (if configured)
        if (state.registered && config.registrationContext) {
          const folder = extractFolder(process.cwd());
          const locationPart = state.gitBranch
            ? `${folder} on ${state.gitBranch}`
            : folder;
          pi.sendMessage({
            content: `You are agent "${state.agentName}" in ${locationPart}. Other agents working on this or related codebases may send you coordination messages. Use pi_messenger({ to: "Name", message: "..." }) to reply, pi_messenger({ list: true }) to see active peers, or /messenger to open the chat overlay.`,
            display: false
          }, { triggerTurn: false });
        }
        
        return joinResult;
      }

      // All other operations require registration
      if (!state.registered) return handlers.notRegisteredError();

      if (to || broadcast) return handlers.executeSend(state, dirs, to, broadcast, message, replyTo);
      if (reserve && reserve.length > 0) return handlers.executeReserve(state, dirs, ctx, reserve, reason);
      if (release === true || (Array.isArray(release) && release.length > 0)) {
        return handlers.executeRelease(state, dirs, ctx, release);
      }
      if (rename) return handlers.executeRename(state, dirs, ctx, rename, deliverMessage, updateStatus);
      if (list) return handlers.executeList(state, dirs);
      return handlers.executeStatus(state, dirs);
    }
  });

  // ===========================================================================
  // Commands
  // ===========================================================================

  pi.registerCommand("messenger", {
    description: "Open messenger overlay (auto-joins if not registered)",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;

      // Auto-join when user opens overlay
      if (!state.registered) {
        if (!store.register(state, dirs, ctx)) {
          ctx.ui.notify("Failed to join agent mesh", "error");
          return;
        }
        store.startWatcher(state, dirs, deliverMessage);
        updateStatus(ctx);
      }

      await ctx.ui.custom<void>(
        (tui, theme, _keybindings, done) => {
          overlayTui = tui;
          return new MessengerOverlay(tui, theme, state, dirs, done);
        },
        {
          overlay: true,
          overlayOptions: {
            width: "80%",
            maxHeight: "45%",
            anchor: "center",
            margin: 1,
          },
        }
      );

      // Overlay closed
      overlayTui = null;
      updateStatus(ctx);
    }
  });

  // ===========================================================================
  // Message Renderer
  // ===========================================================================

  pi.registerMessageRenderer<AgentMailMessage>("agent_message", (message, _options, theme) => {
    const details = message.details;
    if (!details) return undefined;

    return {
      render(width: number): string[] {
        const safeFrom = stripAnsiCodes(details.from);
        const safeText = stripAnsiCodes(details.text);
        
        const header = theme.fg("accent", `From ${safeFrom}`);
        const time = theme.fg("dim", ` (${formatRelativeTime(details.timestamp)})`);

        const result: string[] = [];
        result.push(truncateToWidth(header + time, width));
        result.push("");

        for (const line of safeText.split("\n")) {
          result.push(truncateToWidth(line, width));
        }

        return result;
      },
      invalidate() {}
    };
  });

  // ===========================================================================
  // Event Handlers
  // ===========================================================================

  pi.on("session_start", async (_event, ctx) => {
    // Only auto-register if configured (default: false)
    if (!config.autoRegister) return;

    if (store.register(state, dirs, ctx)) {
      store.startWatcher(state, dirs, deliverMessage);
      updateStatus(ctx);

      // Send registration context (non-displaying, non-triggering)
      if (config.registrationContext) {
        const folder = extractFolder(process.cwd());
        const locationPart = state.gitBranch
          ? `${folder} on ${state.gitBranch}`
          : folder;
        pi.sendMessage({
          content: `You are agent "${state.agentName}" in ${locationPart}. Other agents working on this or related codebases may send you coordination messages. Use pi_messenger({ to: "Name", message: "..." }) to reply, pi_messenger({ list: true }) to see active peers, or /messenger to open the chat overlay.`,
          display: false
        }, { triggerTurn: false });
      }
    }
  });

  function recoverWatcherIfNeeded(): void {
    if (state.registered && !state.watcher && !state.watcherRetryTimer) {
      state.watcherRetries = 0;
      store.startWatcher(state, dirs, deliverMessage);
    }
  }

  pi.on("session_switch", async (_event, ctx) => {
    recoverWatcherIfNeeded();
    updateStatus(ctx);
  });
  pi.on("session_fork", async (_event, ctx) => {
    recoverWatcherIfNeeded();
    updateStatus(ctx);
  });
  pi.on("session_tree", async (_event, ctx) => updateStatus(ctx));

  pi.on("turn_end", async (_event, ctx) => {
    store.processAllPendingMessages(state, dirs, deliverMessage);
    recoverWatcherIfNeeded();
    updateStatus(ctx);
  });

  pi.on("session_shutdown", async () => {
    store.stopWatcher(state);
    store.unregister(state, dirs);
  });

  // ===========================================================================
  // Reservation Enforcement
  // ===========================================================================

  pi.on("tool_call", async (event, _ctx) => {
    // Only block write operations - reading reserved files is fine
    if (!["edit", "write"].includes(event.toolName)) return;

    const path = event.input.path as string;
    if (!path) return;

    const conflicts = store.getConflictsWithOtherAgents(path, state, dirs);
    if (conflicts.length === 0) return;

    const c = conflicts[0];
    const agent = store.getActiveAgents(state, dirs).find(a => a.name === c.agent);
    const folder = agent ? extractFolder(agent.cwd) : undefined;
    const locationPart = folder
      ? agent?.gitBranch
        ? ` (in ${folder} on ${agent.gitBranch})`
        : ` (in ${folder})`
      : "";

    const lines = [path, `Reserved by: ${c.agent}${locationPart}`];
    if (c.reason) lines.push(`Reason: "${c.reason}"`);
    lines.push("");
    lines.push(`Coordinate via pi_messenger({ to: "${c.agent}", message: "..." })`);

    return { block: true, reason: lines.join("\n") };
  });
}
