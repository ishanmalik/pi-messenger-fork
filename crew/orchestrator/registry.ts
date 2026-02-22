import * as fs from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import type { SpawnedAgent, SpawnedAgentStatus, HistoryEvent } from "./types.js";

const spawnedByThisProcess = new Set<string>();

const VALID_TRANSITIONS: Record<SpawnedAgentStatus, Set<SpawnedAgentStatus>> = {
  spawning: new Set(["joined", "dead"]),
  joined: new Set(["idle", "dead"]),
  idle: new Set(["assigned", "done", "dead"]),
  assigned: new Set(["idle", "done", "dead"]),
  done: new Set(["dead"]),
  dead: new Set(),
};

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function writeJsonAtomic(filePath: string, data: unknown): void {
  ensureDir(dirname(filePath));
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filePath);
}

function readJson<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
  } catch {
    return null;
  }
}

function isStatus(value: unknown): value is SpawnedAgentStatus {
  return typeof value === "string"
    && (value === "spawning"
      || value === "joined"
      || value === "idle"
      || value === "assigned"
      || value === "done"
      || value === "dead");
}

function isSpawnedAgent(value: unknown): value is SpawnedAgent {
  if (!value || typeof value !== "object") return false;
  const v = value as SpawnedAgent;
  return typeof v.name === "string"
    && typeof v.pid === "number"
    && typeof v.sessionId === "string"
    && (typeof v.tmuxPaneId === "string" || v.tmuxPaneId === null)
    && (typeof v.tmuxWindowId === "string" || v.tmuxWindowId === null)
    && typeof v.model === "string"
    && (v.thinking === undefined || typeof v.thinking === "string")
    && isStatus(v.status)
    && typeof v.spawnedAt === "number"
    && typeof v.spawnedBy === "string"
    && (typeof v.assignedTask === "string" || v.assignedTask === null)
    && typeof v.lastActivityAt === "number"
    && (v.backend === "tmux" || v.backend === "headless");
}

function orchestratorDir(cwd: string = process.cwd()): string {
  return join(cwd, ".pi", "messenger", "orchestrator");
}

function agentsDir(cwd: string = process.cwd()): string {
  return join(orchestratorDir(cwd), "agents");
}

function historyPath(cwd: string = process.cwd()): string {
  return join(orchestratorDir(cwd), "history.jsonl");
}

function meshRegistryDir(): string {
  const baseDir = process.env.PI_MESSENGER_DIR || join(homedir(), ".pi", "agent", "messenger");
  return join(baseDir, "registry");
}

function agentFilePath(name: string, cwd: string = process.cwd()): string {
  return join(agentsDir(cwd), `${name}.json`);
}

function canTransition(from: SpawnedAgentStatus, to: SpawnedAgentStatus): boolean {
  if (from === to) return true;
  return VALID_TRANSITIONS[from].has(to);
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function cleanupTmux(agent: SpawnedAgent): void {
  if (!agent.tmuxPaneId) return;
  try {
    execFileSync("tmux", ["kill-pane", "-t", agent.tmuxPaneId], { stdio: "ignore" });
  } catch {
    // ignore
  }
}

function findMeshRegistration(name: string): Record<string, unknown> | null {
  const filePath = join(meshRegistryDir(), `${name}.json`);
  return readJson<Record<string, unknown>>(filePath);
}

function markDeadAndDelete(agent: SpawnedAgent, cwd: string, reason: string): void {
  const filePath = agentFilePath(agent.name, cwd);
  try {
    const dead: SpawnedAgent = {
      ...agent,
      status: "dead",
      assignedTask: null,
      lastActivityAt: Date.now(),
    };
    writeJsonAtomic(filePath, dead);
  } catch {
    // ignore
  }

  cleanupTmux(agent);

  try {
    fs.unlinkSync(filePath);
  } catch {
    // ignore
  }

  spawnedByThisProcess.delete(agent.name);
  logHistory({
    event: "reap",
    agent: agent.name,
    timestamp: new Date().toISOString(),
    details: {
      reason,
      pid: agent.pid,
      previousStatus: agent.status,
    },
  }, cwd);
}

function shouldReap(agent: SpawnedAgent): string | null {
  if (!isPidAlive(agent.pid)) {
    return "pid_exited";
  }

  const reg = findMeshRegistration(agent.name);
  if (!reg) {
    return "mesh_missing";
  }

  const meshPid = typeof reg.pid === "number" ? reg.pid : Number(reg.pid);
  if (!Number.isFinite(meshPid) || meshPid !== agent.pid) {
    return "mesh_pid_mismatch";
  }

  return null;
}

export function registerSpawned(agent: SpawnedAgent, cwd: string = process.cwd()): void {
  writeJsonAtomic(agentFilePath(agent.name, cwd), agent);
  if (agent.status !== "dead") {
    spawnedByThisProcess.add(agent.name);
  }
}

export function unregisterSpawned(name: string, cwd: string = process.cwd()): void {
  try {
    fs.unlinkSync(agentFilePath(name, cwd));
  } catch {
    // ignore
  }
  spawnedByThisProcess.delete(name);
}

export function getSpawned(name: string, cwd: string = process.cwd()): SpawnedAgent | null {
  const parsed = readJson<unknown>(agentFilePath(name, cwd));
  return isSpawnedAgent(parsed) ? parsed : null;
}

export function getAllSpawned(cwd: string = process.cwd()): SpawnedAgent[] {
  const dir = agentsDir(cwd);
  if (!fs.existsSync(dir)) return [];

  const entries: SpawnedAgent[] = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    const parsed = readJson<unknown>(join(dir, file));
    if (isSpawnedAgent(parsed)) {
      entries.push(parsed);
    }
  }

  return entries.sort((a, b) => a.spawnedAt - b.spawnedAt);
}

export function transitionState(
  name: string,
  to: SpawnedAgentStatus,
  cwd: string = process.cwd(),
): boolean {
  const current = getSpawned(name, cwd);
  if (!current) return false;
  if (!canTransition(current.status, to)) return false;

  const updated: SpawnedAgent = {
    ...current,
    status: to,
    ...(to === "dead" ? { assignedTask: null } : {}),
  };

  registerSpawned(updated, cwd);
  if (to === "dead") {
    spawnedByThisProcess.delete(name);
  }
  return true;
}

export function isOrchestrator(): boolean {
  return spawnedByThisProcess.size > 0;
}

export function logHistory(event: HistoryEvent, cwd: string = process.cwd()): void {
  const filePath = historyPath(cwd);
  ensureDir(dirname(filePath));
  try {
    fs.appendFileSync(filePath, JSON.stringify(event) + "\n");
  } catch {
    // ignore
  }
}

export function reapOrphans(cwd: string = process.cwd()): string[] {
  const reaped: string[] = [];
  const all = getAllSpawned(cwd);

  for (const agent of all) {
    if (agent.status === "dead") continue;
    const reason = shouldReap(agent);
    if (!reason) continue;

    markDeadAndDelete(agent, cwd, reason);
    reaped.push(agent.name);
  }

  return reaped;
}

export function checkSpawnedAgentHealth(cwd: string = process.cwd()): string[] {
  return reapOrphans(cwd);
}

export function killAllSpawned(cwd: string = process.cwd()): void {
  const all = getAllSpawned(cwd);
  for (const agent of all) {
    if (agent.status === "dead") {
      unregisterSpawned(agent.name, cwd);
      continue;
    }
    try {
      process.kill(agent.pid, "SIGTERM");
    } catch {
      // ignore
    }
    cleanupTmux(agent);
    unregisterSpawned(agent.name, cwd);
  }
}
