/**
 * Pi Messenger - Tool and Command Handlers
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  type MessengerState,
  type Dirs,
  type AgentMailMessage,
  type AgentRegistration,
  formatRelativeTime,
  extractFolder,
  truncatePathLeft,
  getDisplayMode
} from "./lib.js";
import * as store from "./store.js";

// =============================================================================
// Tool Result Helper
// =============================================================================

function result(text: string, details: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text }],
    details
  };
}

// =============================================================================
// Not Registered Error
// =============================================================================

export function notRegisteredError() {
  return result(
    "Not registered. Use pi_messenger({ join: true }) to join the agent mesh first.",
    { mode: "error", error: "not_registered" }
  );
}

// =============================================================================
// Tool Execute Functions
// =============================================================================

export function executeJoin(
  state: MessengerState,
  dirs: Dirs,
  ctx: ExtensionContext,
  deliverFn: (msg: AgentMailMessage) => void,
  updateStatusFn: (ctx: ExtensionContext) => void
) {
  if (state.registered) {
    const agents = store.getActiveAgents(state, dirs);
    return result(
      `Already joined as ${state.agentName}. ${agents.length} peer${agents.length === 1 ? "" : "s"} active.`,
      { mode: "join", alreadyJoined: true, name: state.agentName, peerCount: agents.length }
    );
  }

  if (!store.register(state, dirs, ctx)) {
    return result(
      "Failed to join the agent mesh. Check logs for details.",
      { mode: "join", error: "registration_failed" }
    );
  }

  store.startWatcher(state, dirs, deliverFn);
  updateStatusFn(ctx);

  const agents = store.getActiveAgents(state, dirs);
  const folder = extractFolder(process.cwd());
  const locationPart = state.gitBranch ? `${folder} on ${state.gitBranch}` : folder;

  let text = `Joined as ${state.agentName} in ${locationPart}. ${agents.length} peer${agents.length === 1 ? "" : "s"} active.`;
  
  if (agents.length > 0) {
    text += `\n\nActive peers: ${agents.map(a => a.name).join(", ")}`;
    text += `\n\nUse pi_messenger({ list: true }) for details, or pi_messenger({ to: "Name", message: "..." }) to send.`;
  }

  return result(text, {
    mode: "join",
    name: state.agentName,
    location: locationPart,
    peerCount: agents.length,
    peers: agents.map(a => a.name)
  });
}

export function executeStatus(state: MessengerState, dirs: Dirs) {
  if (!state.registered) {
    return notRegisteredError();
  }

  const agents = store.getActiveAgents(state, dirs);
  const folder = extractFolder(process.cwd());
  const location = state.gitBranch ? `${folder} (${state.gitBranch})` : folder;

  let text = `You: ${state.agentName}\n`;
  text += `Location: ${location}\n`;
  text += `Peers: ${agents.length}\n`;
  if (state.reservations.length > 0) {
    const myRes = state.reservations.map(r => `🔒 ${truncatePathLeft(r.pattern, 40)}`);
    text += `Reservations: ${myRes.join(", ")}\n`;
  }
  text += `\nUse { list: true } to see other agents, { to: "Name", message: "..." } to send.`;

  return result(text, {
    mode: "status",
    registered: true,
    self: state.agentName,
    folder,
    gitBranch: state.gitBranch,
    peerCount: agents.length,
    reservations: state.reservations
  });
}

export function executeList(state: MessengerState, dirs: Dirs) {
  if (!state.registered) {
    return notRegisteredError();
  }

  const agents = store.getActiveAgents(state, dirs);

  if (agents.length === 0) {
    return result(
      "No other agents currently active.",
      { mode: "list", registered: true, agents: [], self: state.agentName }
    );
  }

  const mode = getDisplayMode(agents);
  const lines: string[] = [];

  function formatReservations(a: AgentRegistration): string[] {
    if (!a.reservations || a.reservations.length === 0) return [];
    return a.reservations.map(r => `🔒 ${truncatePathLeft(r.pattern, 40)}`);
  }

  if (mode === "same-folder-branch") {
    const folder = extractFolder(agents[0].cwd);
    const branch = agents.find(a => a.gitBranch)?.gitBranch;
    const header = branch ? `Peers in ${folder} (${branch}):` : `Peers in ${folder}:`;
    lines.push(header, "");

    for (const a of agents) {
      const time = formatRelativeTime(a.startedAt);
      lines.push(`  ${a.name.padEnd(14)} ${a.model.padEnd(20)} ${time}`);
      for (const res of formatReservations(a)) {
        lines.push(`                 ${res}`);
      }
    }
  } else if (mode === "same-folder") {
    const folder = extractFolder(agents[0].cwd);
    lines.push(`Peers in ${folder}:`, "");

    for (const a of agents) {
      const branch = a.gitBranch ?? "";
      const time = formatRelativeTime(a.startedAt);
      lines.push(`  ${a.name.padEnd(14)} ${branch.padEnd(12)} ${a.model.padEnd(20)} ${time}`);
      for (const res of formatReservations(a)) {
        lines.push(`                 ${res}`);
      }
    }
  } else {
    lines.push("Peers:", "");

    for (const a of agents) {
      const folder = extractFolder(a.cwd);
      const branch = a.gitBranch ?? "";
      const time = formatRelativeTime(a.startedAt);
      lines.push(`  ${a.name.padEnd(14)} ${folder.padEnd(20)} ${branch.padEnd(12)} ${a.model.padEnd(20)} ${time}`);
      for (const res of formatReservations(a)) {
        lines.push(`                 ${res}`);
      }
    }
  }

  return result(
    lines.join("\n"),
    { mode: "list", registered: true, agents, self: state.agentName }
  );
}

export function executeSend(
  state: MessengerState,
  dirs: Dirs,
  to: string | string[] | undefined,
  broadcast: boolean | undefined,
  message?: string,
  replyTo?: string
) {
  if (!state.registered) {
    return notRegisteredError();
  }

  if (!message) {
    return result(
      "Error: message is required when sending.",
      { mode: "send", error: "missing_message" }
    );
  }

  let recipients: string[];
  if (broadcast) {
    const agents = store.getActiveAgents(state, dirs);
    recipients = agents.map(a => a.name);
    if (recipients.length === 0) {
      return result(
        "No active agents to broadcast to.",
        { mode: "send", error: "no_recipients" }
      );
    }
  } else if (to) {
    recipients = [...new Set(Array.isArray(to) ? to : [to])];
    if (recipients.length === 0) {
      return result(
        "Error: recipient list cannot be empty.",
        { mode: "send", error: "empty_recipients" }
      );
    }
  } else {
    return result(
      "Error: specify 'to' or 'broadcast: true'.",
      { mode: "send", error: "missing_recipient" }
    );
  }

  const sent: string[] = [];
  const failed: Array<{ name: string; error: string }> = [];

  for (const recipient of recipients) {
    if (recipient === state.agentName) {
      failed.push({ name: recipient, error: "cannot send to self" });
      continue;
    }

    const validation = store.validateTargetAgent(recipient, dirs);
    if (!validation.valid) {
      const errorMap: Record<string, string> = {
        invalid_name: "invalid name",
        not_found: "not found",
        not_active: "no longer active",
        invalid_registration: "invalid registration",
      };
      const errKey = (validation as { valid: false; error: string }).error;
      failed.push({ name: recipient, error: errorMap[errKey] });
      continue;
    }

    try {
      store.sendMessageToAgent(state, dirs, recipient, message, replyTo);
      sent.push(recipient);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "write failed";
      failed.push({ name: recipient, error: msg });
    }
  }

  if (sent.length === 0) {
    const failedStr = failed.map(f => `${f.name} (${f.error})`).join(", ");
    return result(
      `Failed to send: ${failedStr}`,
      { mode: "send", error: "all_failed", sent: [], failed }
    );
  }

  let text = `Message sent to ${sent.join(", ")}.`;
  if (failed.length > 0) {
    const failedStr = failed.map(f => `${f.name} (${f.error})`).join(", ");
    text += ` Failed: ${failedStr}`;
  }

  return result(text, { mode: "send", sent, failed });
}

export function executeReserve(
  state: MessengerState,
  dirs: Dirs,
  ctx: ExtensionContext,
  patterns: string[],
  reason?: string
) {
  if (!state.registered) {
    return notRegisteredError();
  }

  if (patterns.length === 0) {
    return result(
      "Error: at least one pattern required.",
      { mode: "reserve", error: "empty_patterns" }
    );
  }

  const now = new Date().toISOString();

  for (const pattern of patterns) {
    state.reservations = state.reservations.filter(r => r.pattern !== pattern);
    state.reservations.push({ pattern, reason, since: now });
  }

  store.updateRegistration(state, dirs, ctx);

  return result(`Reserved: ${patterns.join(", ")}`, { mode: "reserve", patterns, reason });
}

export function executeRelease(
  state: MessengerState,
  dirs: Dirs,
  ctx: ExtensionContext,
  release: string[] | true
) {
  if (!state.registered) {
    return notRegisteredError();
  }

  if (release === true) {
    const released = state.reservations.map(r => r.pattern);
    state.reservations = [];
    store.updateRegistration(state, dirs, ctx);
    return result(
      released.length > 0 ? `Released all: ${released.join(", ")}` : "No reservations to release.",
      { mode: "release", released }
    );
  }

  const patterns = release;
  const before = state.reservations.length;
  state.reservations = state.reservations.filter(r => !patterns.includes(r.pattern));
  const releasedCount = before - state.reservations.length;

  store.updateRegistration(state, dirs, ctx);

  return result(`Released ${releasedCount} reservation(s).`, { mode: "release", released: patterns });
}

export function executeRename(
  state: MessengerState,
  dirs: Dirs,
  ctx: ExtensionContext,
  newName: string,
  deliverFn: (msg: AgentMailMessage) => void,
  updateStatusFn: (ctx: ExtensionContext) => void
) {
  store.stopWatcher(state);

  const renameResult = store.renameAgent(state, dirs, ctx, newName, deliverFn);

  if (!renameResult.success) {
    store.startWatcher(state, dirs, deliverFn);
    
    const errCode = (renameResult as { success: false; error: string }).error;
    const errorMessages: Record<string, string> = {
      not_registered: "Cannot rename - not registered.",
      invalid_name: `Invalid name "${newName}" - use only letters, numbers, underscore, hyphen.`,
      name_taken: `Name "${newName}" is already in use by another agent.`,
      same_name: `Already named "${newName}".`,
      race_lost: `Name "${newName}" was claimed by another agent.`,
    };
    return result(
      `Error: ${errorMessages[errCode]}`,
      { mode: "rename", error: errCode }
    );
  }

  state.watcherRetries = 0;
  store.startWatcher(state, dirs, deliverFn);
  updateStatusFn(ctx);

  return result(
    `Renamed from "${renameResult.oldName}" to "${renameResult.newName}".`,
    { mode: "rename", oldName: renameResult.oldName, newName: renameResult.newName }
  );
}


