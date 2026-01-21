/**
 * Pi Messenger - File Storage Operations
 */

import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { execSync } from "node:child_process";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  type AgentRegistration,
  type AgentMailMessage,
  type ReservationConflict,
  type MessengerState,
  type Dirs,
  MAX_WATCHER_RETRIES,
  isProcessAlive,
  generateMemorableName,
  isValidAgentName,
  pathMatchesReservation,
} from "./lib.js";

// =============================================================================
// Agents Cache (Fix 1: Reduce disk I/O)
// =============================================================================

interface AgentsCache {
  allAgents: AgentRegistration[];
  filtered: Map<string, AgentRegistration[]>;  // keyed by excluded agent name
  timestamp: number;
  registryPath: string;
}

const AGENTS_CACHE_TTL_MS = 1000;
let agentsCache: AgentsCache | null = null;

export function invalidateAgentsCache(): void {
  agentsCache = null;
}

// =============================================================================
// Message Processing Guard (Fix 3: Prevent race conditions)
// =============================================================================

let isProcessingMessages = false;
let pendingProcessArgs: {
  state: MessengerState;
  dirs: Dirs;
  deliverFn: (msg: AgentMailMessage) => void;
} | null = null;

// =============================================================================
// File System Helpers
// =============================================================================

function ensureDirSync(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function getGitBranch(cwd: string): string | undefined {
  try {
    const result = execSync('git branch --show-current', {
      cwd,
      encoding: 'utf-8',
      timeout: 2000,
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();

    if (result) return result;

    const sha = execSync('git rev-parse --short HEAD', {
      cwd,
      encoding: 'utf-8',
      timeout: 2000,
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();

    return sha ? `@${sha}` : undefined;
  } catch {
    return undefined;
  }
}

// =============================================================================
// Registry Operations
// =============================================================================

export function getRegistrationPath(state: MessengerState, dirs: Dirs): string {
  return join(dirs.registry, `${state.agentName}.json`);
}

export function getActiveAgents(state: MessengerState, dirs: Dirs): AgentRegistration[] {
  const now = Date.now();
  const excludeName = state.agentName;

  // Return cached if valid (Fix 1)
  if (
    agentsCache &&
    agentsCache.registryPath === dirs.registry &&
    now - agentsCache.timestamp < AGENTS_CACHE_TTL_MS
  ) {
    // Check if we have a cached filtered result for this agent name
    const cachedFiltered = agentsCache.filtered.get(excludeName);
    if (cachedFiltered) return cachedFiltered;

    // Create and cache filtered result
    const filtered = agentsCache.allAgents.filter(a => a.name !== excludeName);
    agentsCache.filtered.set(excludeName, filtered);
    return filtered;
  }

  // Read from disk
  const allAgents: AgentRegistration[] = [];

  if (!fs.existsSync(dirs.registry)) {
    agentsCache = { allAgents, filtered: new Map(), timestamp: now, registryPath: dirs.registry };
    return allAgents;
  }

  let files: string[];
  try {
    files = fs.readdirSync(dirs.registry);
  } catch {
    return allAgents;
  }

  for (const file of files) {
    if (!file.endsWith(".json")) continue;

    try {
      const content = fs.readFileSync(join(dirs.registry, file), "utf-8");
      const reg: AgentRegistration = JSON.parse(content);

      if (!isProcessAlive(reg.pid)) {
        try {
          fs.unlinkSync(join(dirs.registry, file));
        } catch {
          // Ignore cleanup errors
        }
        continue;
      }

      allAgents.push(reg);
    } catch {
      // Ignore malformed registrations
    }
  }

  // Cache the full list and create filtered result
  const filtered = allAgents.filter(a => a.name !== excludeName);
  const filteredMap = new Map<string, AgentRegistration[]>();
  filteredMap.set(excludeName, filtered);

  agentsCache = { allAgents, filtered: filteredMap, timestamp: now, registryPath: dirs.registry };

  return filtered;
}

export function findAvailableName(baseName: string, dirs: Dirs): string | null {
  const basePath = join(dirs.registry, `${baseName}.json`);
  if (!fs.existsSync(basePath)) return baseName;

  try {
    const existing: AgentRegistration = JSON.parse(fs.readFileSync(basePath, "utf-8"));
    if (!isProcessAlive(existing.pid) || existing.pid === process.pid) {
      return baseName;
    }
  } catch {
    return baseName;
  }

  for (let i = 2; i <= 99; i++) {
    const altName = `${baseName}${i}`;
    const altPath = join(dirs.registry, `${altName}.json`);

    if (!fs.existsSync(altPath)) return altName;

    try {
      const altReg: AgentRegistration = JSON.parse(fs.readFileSync(altPath, "utf-8"));
      if (!isProcessAlive(altReg.pid)) return altName;
    } catch {
      return altName;
    }
  }

  return null;
}

export function register(state: MessengerState, dirs: Dirs, ctx: ExtensionContext): boolean {
  if (state.registered) return true;

  ensureDirSync(dirs.registry);

  if (!state.agentName) {
    state.agentName = generateMemorableName();
  }

  const isExplicitName = !!process.env.PI_AGENT_NAME;
  const maxAttempts = isExplicitName ? 1 : 3;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // Validate and find available name
    if (isExplicitName) {
      if (!isValidAgentName(state.agentName)) {
        if (ctx.hasUI) {
          ctx.ui.notify(`Invalid agent name "${state.agentName}" - use only letters, numbers, underscore, hyphen`, "error");
        }
        return false;
      }
      const regPath = join(dirs.registry, `${state.agentName}.json`);
      if (fs.existsSync(regPath)) {
        try {
          const existing: AgentRegistration = JSON.parse(fs.readFileSync(regPath, "utf-8"));
          if (isProcessAlive(existing.pid) && existing.pid !== process.pid) {
            if (ctx.hasUI) {
              ctx.ui.notify(`Agent name "${state.agentName}" already in use (PID ${existing.pid})`, "error");
            }
            return false;
          }
        } catch {
          // Malformed, proceed to overwrite
        }
      }
    } else {
      const availableName = findAvailableName(state.agentName, dirs);
      if (!availableName) {
        if (ctx.hasUI) {
          ctx.ui.notify("Could not find available agent name after 99 attempts", "error");
        }
        return false;
      }
      state.agentName = availableName;
    }

    const regPath = getRegistrationPath(state, dirs);
    if (fs.existsSync(regPath)) {
      try {
        fs.unlinkSync(regPath);
      } catch {
        // Ignore
      }
    }

    ensureDirSync(getMyInbox(state, dirs));

    const gitBranch = getGitBranch(process.cwd());
    const registration: AgentRegistration = {
      name: state.agentName,
      pid: process.pid,
      sessionId: ctx.sessionManager.getSessionId(),
      cwd: process.cwd(),
      model: ctx.model?.id ?? "unknown",
      startedAt: new Date().toISOString(),
      gitBranch
    };

    try {
      fs.writeFileSync(regPath, JSON.stringify(registration, null, 2));
    } catch (err) {
      if (ctx.hasUI) {
        const msg = err instanceof Error ? err.message : "unknown error";
        ctx.ui.notify(`Failed to register: ${msg}`, "error");
      }
      return false;
    }

    // Verify we own the registration (guards against race condition where
    // two agents try to claim the same name simultaneously)
    let verified = false;
    try {
      const written: AgentRegistration = JSON.parse(fs.readFileSync(regPath, "utf-8"));
      verified = written.pid === process.pid;
    } catch {
      // Read failed - file may have been overwritten or deleted
    }

    if (verified) {
      state.registered = true;
      state.gitBranch = gitBranch;
      invalidateAgentsCache();
      return true;
    }

    // Another agent claimed this name - retry with fresh lookup (auto-generated only)
    if (isExplicitName) {
      if (ctx.hasUI) {
        ctx.ui.notify(`Agent name "${state.agentName}" was claimed by another agent`, "error");
      }
      return false;
    }
    invalidateAgentsCache();
  }

  // Exhausted retries
  if (ctx.hasUI) {
    ctx.ui.notify("Failed to register after multiple attempts due to name conflicts", "error");
  }
  return false;
}

export function updateRegistration(state: MessengerState, dirs: Dirs, ctx: ExtensionContext): void {
  if (!state.registered) return;

  const regPath = getRegistrationPath(state, dirs);
  if (!fs.existsSync(regPath)) return;

  try {
    const reg: AgentRegistration = JSON.parse(fs.readFileSync(regPath, "utf-8"));
    reg.model = ctx.model?.id ?? reg.model;
    reg.reservations = state.reservations.length > 0 ? state.reservations : undefined;
    fs.writeFileSync(regPath, JSON.stringify(reg, null, 2));
  } catch {
    // Ignore errors
  }
}

export function unregister(state: MessengerState, dirs: Dirs): void {
  if (!state.registered) return;

  try {
    fs.unlinkSync(getRegistrationPath(state, dirs));
  } catch {
    // Ignore errors
  }
  state.registered = false;
  invalidateAgentsCache();
}

export type RenameResult =
  | { success: true; oldName: string; newName: string }
  | { success: false; error: "not_registered" | "invalid_name" | "name_taken" | "same_name" | "race_lost" };

export function renameAgent(
  state: MessengerState,
  dirs: Dirs,
  ctx: ExtensionContext,
  newName: string,
  deliverFn: (msg: AgentMailMessage) => void
): RenameResult {
  if (!state.registered) {
    return { success: false, error: "not_registered" };
  }

  if (!isValidAgentName(newName)) {
    return { success: false, error: "invalid_name" };
  }

  if (newName === state.agentName) {
    return { success: false, error: "same_name" };
  }

  const newRegPath = join(dirs.registry, `${newName}.json`);
  if (fs.existsSync(newRegPath)) {
    try {
      const existing: AgentRegistration = JSON.parse(fs.readFileSync(newRegPath, "utf-8"));
      if (isProcessAlive(existing.pid) && existing.pid !== process.pid) {
        return { success: false, error: "name_taken" };
      }
    } catch {
      // Malformed file, we can overwrite
    }
  }

  const oldName = state.agentName;
  const oldRegPath = getRegistrationPath(state, dirs);
  const oldInbox = getMyInbox(state, dirs);
  const newInbox = join(dirs.inbox, newName);

  processAllPendingMessages(state, dirs, deliverFn);

  const gitBranch = getGitBranch(process.cwd());
  const registration: AgentRegistration = {
    name: newName,
    pid: process.pid,
    sessionId: ctx.sessionManager.getSessionId(),
    cwd: process.cwd(),
    model: ctx.model?.id ?? "unknown",
    startedAt: new Date().toISOString(),
    reservations: state.reservations.length > 0 ? state.reservations : undefined,
    gitBranch
  };

  ensureDirSync(dirs.registry);
  
  try {
    fs.writeFileSync(join(dirs.registry, `${newName}.json`), JSON.stringify(registration, null, 2));
  } catch (err) {
    return { success: false, error: "invalid_name" as const };
  }

  // Verify we own the new registration (guards against race condition)
  try {
    const written: AgentRegistration = JSON.parse(fs.readFileSync(newRegPath, "utf-8"));
    if (written.pid !== process.pid) {
      return { success: false, error: "race_lost" };
    }
  } catch {
    return { success: false, error: "race_lost" };
  }

  try {
    fs.unlinkSync(oldRegPath);
  } catch {
    // Ignore - old file might already be gone
  }

  state.agentName = newName;

  if (fs.existsSync(newInbox)) {
    try {
      const staleFiles = fs.readdirSync(newInbox).filter(f => f.endsWith(".json"));
      for (const file of staleFiles) {
        try {
          fs.unlinkSync(join(newInbox, file));
        } catch {
          // Ignore
        }
      }
    } catch {
      // Ignore
    }
  }
  ensureDirSync(newInbox);

  try {
    fs.rmdirSync(oldInbox);
  } catch {
    // Ignore - might have new messages or not exist
  }

  state.gitBranch = gitBranch;
  invalidateAgentsCache();
  return { success: true, oldName, newName };
}

export function getConflictsWithOtherAgents(
  filePath: string,
  state: MessengerState,
  dirs: Dirs
): ReservationConflict[] {
  const conflicts: ReservationConflict[] = [];
  const agents = getActiveAgents(state, dirs);

  for (const agent of agents) {
    if (!agent.reservations) continue;
    for (const res of agent.reservations) {
      if (pathMatchesReservation(filePath, res.pattern)) {
        conflicts.push({
          path: filePath,
          agent: agent.name,
          pattern: res.pattern,
          reason: res.reason
        });
      }
    }
  }

  return conflicts;
}

// =============================================================================
// Messaging Operations
// =============================================================================

export function getMyInbox(state: MessengerState, dirs: Dirs): string {
  return join(dirs.inbox, state.agentName);
}

export function processAllPendingMessages(
  state: MessengerState,
  dirs: Dirs,
  deliverFn: (msg: AgentMailMessage) => void
): void {
  if (!state.registered) return;

  // Fix 3: Prevent concurrent processing
  if (isProcessingMessages) {
    pendingProcessArgs = { state, dirs, deliverFn };
    return;
  }

  isProcessingMessages = true;

  try {
    const inbox = getMyInbox(state, dirs);
    if (!fs.existsSync(inbox)) return;

    let files: string[];
    try {
      files = fs.readdirSync(inbox).filter(f => f.endsWith(".json")).sort();
    } catch {
      return;
    }

    for (const file of files) {
      const msgPath = join(inbox, file);
      try {
        const content = fs.readFileSync(msgPath, "utf-8");
        const msg: AgentMailMessage = JSON.parse(content);
        deliverFn(msg);
        fs.unlinkSync(msgPath);
      } catch {
        // On any failure (read, parse, deliver), delete to avoid infinite retry loops
        try {
          fs.unlinkSync(msgPath);
        } catch {
          // Already gone or can't delete
        }
      }
    }
  } finally {
    isProcessingMessages = false;

    // Re-process if new calls came in while we were processing
    if (pendingProcessArgs) {
      const args = pendingProcessArgs;
      pendingProcessArgs = null;
      processAllPendingMessages(args.state, args.dirs, args.deliverFn);
    }
  }
}

export function sendMessageToAgent(
  state: MessengerState,
  dirs: Dirs,
  to: string,
  text: string,
  replyTo?: string
): AgentMailMessage {
  const targetInbox = join(dirs.inbox, to);
  ensureDirSync(targetInbox);

  const msg: AgentMailMessage = {
    id: randomUUID(),
    from: state.agentName,
    to,
    text,
    timestamp: new Date().toISOString(),
    replyTo: replyTo ?? null
  };

  const random = Math.random().toString(36).substring(2, 8);
  const msgFile = join(targetInbox, `${Date.now()}-${random}.json`);
  fs.writeFileSync(msgFile, JSON.stringify(msg, null, 2));

  return msg;
}

// =============================================================================
// Watcher
// =============================================================================

const WATCHER_DEBOUNCE_MS = 50;

export function startWatcher(
  state: MessengerState,
  dirs: Dirs,
  deliverFn: (msg: AgentMailMessage) => void
): void {
  if (!state.registered) return;
  if (state.watcher) return;
  if (state.watcherRetries >= MAX_WATCHER_RETRIES) return;

  const inbox = getMyInbox(state, dirs);
  ensureDirSync(inbox);

  processAllPendingMessages(state, dirs, deliverFn);

  function scheduleRetry(): void {
    state.watcherRetries++;
    if (state.watcherRetries < MAX_WATCHER_RETRIES) {
      const delay = Math.min(1000 * Math.pow(2, state.watcherRetries - 1), 30000);
      state.watcherRetryTimer = setTimeout(() => {
        state.watcherRetryTimer = null;
        startWatcher(state, dirs, deliverFn);
      }, delay);
    }
  }

  try {
    state.watcher = fs.watch(inbox, () => {
      // Fix 2: Debounce rapid events
      if (state.watcherDebounceTimer) {
        clearTimeout(state.watcherDebounceTimer);
      }
      state.watcherDebounceTimer = setTimeout(() => {
        state.watcherDebounceTimer = null;
        processAllPendingMessages(state, dirs, deliverFn);
      }, WATCHER_DEBOUNCE_MS);
    });
  } catch {
    scheduleRetry();
    return;
  }

  state.watcher.on("error", () => {
    stopWatcher(state);
    scheduleRetry();
  });

  state.watcherRetries = 0;
}

export function stopWatcher(state: MessengerState): void {
  if (state.watcherDebounceTimer) {
    clearTimeout(state.watcherDebounceTimer);
    state.watcherDebounceTimer = null;
  }
  if (state.watcherRetryTimer) {
    clearTimeout(state.watcherRetryTimer);
    state.watcherRetryTimer = null;
  }
  if (state.watcher) {
    state.watcher.close();
    state.watcher = null;
  }
}

// =============================================================================
// Target Validation
// =============================================================================

export type TargetValidation =
  | { valid: true }
  | { valid: false; error: "invalid_name" | "not_found" | "not_active" | "invalid_registration" };

export function validateTargetAgent(to: string, dirs: Dirs): TargetValidation {
  if (!isValidAgentName(to)) {
    return { valid: false, error: "invalid_name" };
  }

  const targetReg = join(dirs.registry, `${to}.json`);
  if (!fs.existsSync(targetReg)) {
    return { valid: false, error: "not_found" };
  }

  try {
    const reg: AgentRegistration = JSON.parse(fs.readFileSync(targetReg, "utf-8"));
    if (!isProcessAlive(reg.pid)) {
      try {
        fs.unlinkSync(targetReg);
      } catch {
        // Ignore cleanup errors
      }
      return { valid: false, error: "not_active" };
    }
  } catch {
    return { valid: false, error: "invalid_registration" };
  }

  return { valid: true };
}
