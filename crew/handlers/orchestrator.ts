import { spawn, type ChildProcess, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { MessengerState, Dirs } from "../../lib.js";
import { generateMemorableName, formatDuration } from "../../lib.js";
import * as messengerStore from "../../store.js";
import { logFeedEvent } from "../../feed.js";
import type { CrewParams } from "../types.js";
import { result } from "../utils/result.js";
import { loadCrewConfig } from "../utils/config.js";
import { pushModelArgs, modelHasThinkingSuffix } from "../agents.js";
import * as crewStore from "../store.js";
import {
  registerSpawned,
  unregisterSpawned,
  getSpawned,
  getAllSpawned,
  transitionState,
  reapOrphans,
  logHistory,
} from "../orchestrator/registry.js";
import type { SpawnedAgent } from "../orchestrator/types.js";
import { getActiveMemoryStore, initMemory, recall, remember, resetMemory, getMemoryStats } from "../orchestrator/memory.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const EXTENSION_DIR = path.resolve(__dirname, "../..");

const HEADLESS_LOG_LIMIT = 2000;
const SPAWN_DIAGNOSTIC_LOG_LINES = 250;
const SPAWN_DIAGNOSTIC_TMUX_LINES = 250;
const SPAWN_TIMEOUT_OVERRIDE_KEYS = ["spawnTimeoutMs", "timeoutMs"] as const;
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);
const SLOW_MODEL_HINTS = [
  "opus",
  "gpt-5",
  "o1",
  "o3",
  "ultra",
  "sonnet-4-6",
  "gemini-2.5-pro",
  "gemini-3-pro",
];

interface HeadlessRuntime {
  proc: ChildProcess;
  logs: string[];
}

interface SpawnTimeoutDiagnostics {
  name: string;
  model: string;
  thinking: string;
  backend: "tmux" | "headless";
  timeoutMs: number;
  expectedPid: number;
  meshPid: number | null;
  meshPidRelation: "none" | "exact" | "descendant" | "mismatch";
  expectedPidAliveBeforeKill: boolean;
  expectedPidAliveAfterKill: boolean;
  meshPidAliveAtTimeout: boolean;
  pidSnapshotExpected: string | null;
  pidSnapshotMesh: string | null;
  meshRegistration: Record<string, unknown> | null;
  tmuxPaneId: string | null;
  tmuxWindowId: string | null;
  tmuxPaneTail: string | null;
  headlessTail: string[];
  signals: {
    sentSigterm: boolean;
    exitedAfterSigterm: boolean;
    sentSigkill: boolean;
  };
  notes: string[];
  createdAt: string;
}

const headlessRuntimes = new Map<string, HeadlessRuntime>();

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function writeJsonAtomic(filePath: string, data: unknown): void {
  ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filePath);
}

function parsePid(raw: unknown): number | null {
  const pid = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(pid) || pid <= 0) return null;
  return Math.floor(pid);
}

function readParentPid(pid: number): number | null {
  try {
    const output = String(execFileSync(
      "ps",
      ["-o", "ppid=", "-p", String(pid)],
      { encoding: "utf-8" },
    )).trim();
    const parsed = Number(output);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  } catch {
    return null;
  }
}

function isDescendantPid(pid: number, ancestorPid: number): boolean {
  if (!Number.isFinite(pid) || !Number.isFinite(ancestorPid)) return false;
  if (pid <= 0 || ancestorPid <= 0) return false;
  if (pid === ancestorPid) return true;

  let current = pid;
  for (let depth = 0; depth < 32; depth++) {
    const parent = readParentPid(current);
    if (!parent || parent <= 1) return false;
    if (parent === ancestorPid) return true;
    if (parent === current) return false;
    current = parent;
  }

  return false;
}

function resolvePidRelation(meshPid: number | null, expectedPid: number): "none" | "exact" | "descendant" | "mismatch" {
  if (!meshPid) return "none";
  if (!expectedPid) return "none";
  if (meshPid === expectedPid) return "exact";
  return isDescendantPid(meshPid, expectedPid) ? "descendant" : "mismatch";
}

function diagnosticsDir(cwd: string): string {
  return path.join(cwd, ".pi", "messenger", "orchestrator", "spawn-diagnostics");
}

function extractThinkingSuffix(model: string | undefined): string | null {
  if (!model) return null;
  const idx = model.lastIndexOf(":");
  if (idx === -1) return null;
  const suffix = model.slice(idx + 1).trim().toLowerCase();
  return THINKING_LEVELS.has(suffix) ? suffix : null;
}

function resolveSpawnTimeoutOverride(params: CrewParams): number | null {
  const payload = params as Record<string, unknown>;
  for (const key of SPAWN_TIMEOUT_OVERRIDE_KEYS) {
    const value = payload[key];
    const parsed = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(parsed)) continue;
    if (parsed <= 0) continue;
    return Math.floor(parsed);
  }
  return null;
}

function modelLooksSlow(model: string): boolean {
  const normalized = model.toLowerCase();
  return SLOW_MODEL_HINTS.some(hint => normalized.includes(hint));
}

function resolveSpawnTimeoutMs(
  params: CrewParams,
  config: ReturnType<typeof loadCrewConfig>,
  model: string,
  thinking: string,
): number {
  const baseMs = Math.max(1000, Math.floor(config.orchestrator.spawnTimeoutMs));
  const maxMs = Math.max(baseMs, Math.floor(config.orchestrator.spawnTimeoutMaxMs || baseMs));

  const overrideMs = resolveSpawnTimeoutOverride(params);
  if (overrideMs && Number.isFinite(overrideMs)) {
    return Math.max(1000, Math.min(Math.floor(overrideMs), maxMs));
  }

  let timeoutMs = baseMs;

  if (modelLooksSlow(model)) {
    const factor = Number.isFinite(config.orchestrator.spawnTimeoutSlowModelMultiplier)
      ? Math.max(1, config.orchestrator.spawnTimeoutSlowModelMultiplier)
      : 1.75;
    timeoutMs = Math.round(timeoutMs * factor);
  }

  const effectiveThinking = extractThinkingSuffix(model) ?? thinking.toLowerCase();
  if (effectiveThinking === "high" || effectiveThinking === "xhigh") {
    const factor = Number.isFinite(config.orchestrator.spawnTimeoutHighThinkingMultiplier)
      ? Math.max(1, config.orchestrator.spawnTimeoutHighThinkingMultiplier)
      : 1.5;
    timeoutMs = Math.round(timeoutMs * factor);
  }

  return Math.max(baseMs, Math.min(timeoutMs, maxMs));
}

function readJson<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
  } catch {
    return null;
  }
}

function readMeshRegistration(name: string, dirs: Dirs): Record<string, unknown> | null {
  return readJson<Record<string, unknown>>(path.join(dirs.registry, `${name}.json`));
}

function parseLastActivityMs(reg: Record<string, unknown> | null): number {
  if (!reg) return Date.now();
  const activity = reg.activity as Record<string, unknown> | undefined;
  const iso = typeof activity?.lastActivityAt === "string"
    ? activity.lastActivityAt
    : undefined;
  const parsed = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function appendHeadlessLogs(name: string, chunk: string): void {
  const runtime = headlessRuntimes.get(name);
  if (!runtime) return;

  for (const line of chunk.replace(/\r/g, "").split("\n")) {
    if (!line) continue;
    runtime.logs.push(line);
  }

  if (runtime.logs.length > HEADLESS_LOG_LIMIT) {
    runtime.logs.splice(0, runtime.logs.length - HEADLESS_LOG_LIMIT);
  }
}

function hasNameCollision(name: string, dirs: Dirs, cwd: string): boolean {
  const local = getSpawned(name, cwd);
  if (local && local.status !== "dead") return true;

  const meshReg = readMeshRegistration(name, dirs);
  if (!meshReg) return false;

  const pid = typeof meshReg.pid === "number" ? meshReg.pid : Number(meshReg.pid);
  if (!Number.isFinite(pid)) return false;
  return isPidAlive(pid);
}

function resolveSpawnName(requested: string | undefined, dirs: Dirs, cwd: string): string | null {
  if (requested && !hasNameCollision(requested, dirs, cwd)) {
    return requested;
  }

  for (let i = 0; i < 5; i++) {
    const generated = generateMemorableName();
    if (!hasNameCollision(generated, dirs, cwd)) {
      return generated;
    }
  }

  return null;
}

interface SpawnProfileModel {
  profile: string;
  model: string;
  filePath: string;
}

function extractFrontmatter(content: string): string {
  const normalized = content.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return "";
  const endIdx = normalized.indexOf("\n---", 4);
  if (endIdx === -1) return "";
  return normalized.slice(4, endIdx);
}

function extractFrontmatterValue(frontmatter: string, key: string): string | null {
  const match = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  if (!match) return null;
  const raw = match[1].trim();
  if (!raw) return null;
  return raw.replace(/^['\"]|['\"]$/g, "");
}

function loadProfileModelFromFile(filePath: string): SpawnProfileModel | null {
  if (!fs.existsSync(filePath)) return null;

  let content = "";
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }

  const frontmatter = extractFrontmatter(content);
  if (!frontmatter) return null;

  const profile = extractFrontmatterValue(frontmatter, "name")
    ?? path.basename(filePath, ".md");
  const model = extractFrontmatterValue(frontmatter, "model");
  if (!model) return null;

  return { profile, model, filePath };
}

function resolveProfileModel(cwd: string, profileName: string): SpawnProfileModel | null {
  const agentsDir = path.join(cwd, ".pi", "agents");
  const directPath = path.join(agentsDir, `${profileName}.md`);
  const direct = loadProfileModelFromFile(directPath);
  if (direct) return direct;

  if (!fs.existsSync(agentsDir)) return null;

  let entries: string[] = [];
  try {
    entries = fs.readdirSync(agentsDir);
  } catch {
    return null;
  }

  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const candidate = loadProfileModelFromFile(path.join(agentsDir, entry));
    if (!candidate) continue;
    if (candidate.profile === profileName) {
      return candidate;
    }
  }

  return null;
}

function clearInbox(dirs: Dirs, name: string): void {
  const inbox = path.join(dirs.inbox, name);
  try { fs.rmSync(inbox, { recursive: true, force: true }); } catch {}
  try { fs.mkdirSync(inbox, { recursive: true }); } catch {}
}

function shellEscape(input: string): string {
  return `'${input.replace(/'/g, `'\\''`)}'`;
}

function buildInitialPrompt(
  name: string,
  model: string,
  orchestratorName: string,
  userPrompt?: string,
): string {
  const custom = userPrompt?.trim() ?? "";
  return `Your FIRST action must be to join the messenger mesh. Call this immediately:

pi_messenger({ action: "join" })

You are "${name}", a ${model} agent spawned by ${orchestratorName} to work on this project.

## Your Role
- Wait for task assignments via DM from ${orchestratorName}
- When you receive a task, implement it fully using the tools available to you
- When done, call: pi_messenger({ action: "agents.done", summary: "Brief description of what you did" })
- You may message ${orchestratorName} at any time for clarification: pi_messenger({ action: "send", to: "${orchestratorName}", message: "..." })
- Reserve files before editing: pi_messenger({ action: "reserve", paths: ["..."] })
- Release files when done: pi_messenger({ action: "release" })

${custom}`.trim();
}

function tmuxAvailable(): boolean {
  try {
    execFileSync("tmux", ["display-message", "-p", "#{session_name}"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function safeKill(pid: number, signal: NodeJS.Signals): void {
  if (!Number.isFinite(pid) || pid <= 0) return;
  try {
    process.kill(pid, signal);
  } catch {
    // ignore
  }
}

function cleanupTmuxPane(agent: SpawnedAgent): void {
  if (!agent.tmuxPaneId) return;
  try {
    execFileSync("tmux", ["kill-pane", "-t", agent.tmuxPaneId], { stdio: "ignore" });
  } catch {
    // ignore
  }
}

function captureTmuxPaneTail(paneId: string | null, lines = SPAWN_DIAGNOSTIC_TMUX_LINES): string | null {
  if (!paneId) return null;
  try {
    const output = String(execFileSync(
      "tmux",
      ["capture-pane", "-t", paneId, "-p", "-S", `-${Math.max(1, lines)}`],
      { encoding: "utf-8" },
    )).trim();
    return output.length > 0 ? output : null;
  } catch {
    return null;
  }
}

function captureHeadlessTail(name: string, lines = SPAWN_DIAGNOSTIC_LOG_LINES): string[] {
  const runtime = headlessRuntimes.get(name);
  if (!runtime) return [];
  return runtime.logs.slice(-Math.max(1, lines));
}

function capturePidSnapshot(pid: number): string | null {
  if (!Number.isFinite(pid) || pid <= 0) return null;
  try {
    const output = String(execFileSync(
      "ps",
      ["-o", "pid=,ppid=,stat=,etime=,command=", "-p", String(pid)],
      { encoding: "utf-8" },
    )).trim();
    return output.length > 0 ? output : null;
  } catch {
    return null;
  }
}

function persistSpawnTimeoutDiagnostics(
  cwd: string,
  name: string,
  diagnostics: SpawnTimeoutDiagnostics,
): string | null {
  try {
    const baseDir = diagnosticsDir(cwd);
    ensureDir(baseDir);
    const fileName = `${Date.now()}-${name}.json`;
    const filePath = path.join(baseDir, fileName);
    writeJsonAtomic(filePath, diagnostics);
    return filePath;
  } catch {
    return null;
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await sleep(Math.min(2000, Math.max(50, deadline - Date.now())));
  }
  return !isPidAlive(pid);
}

function pidMatchesExpectation(meshPid: number, expectedPid?: number): boolean {
  if (!expectedPid || !Number.isFinite(expectedPid) || expectedPid <= 0) {
    return true;
  }
  const relation = resolvePidRelation(meshPid, expectedPid);
  return relation === "exact" || relation === "descendant";
}

async function waitForMeshJoin(
  name: string,
  dirs: Dirs,
  timeoutMs: number,
  expectedPid?: number,
  minRegistryMtimeMs?: number,
): Promise<Record<string, unknown> | null> {
  const budgetMs = Math.max(1000, timeoutMs);
  const deadline = Date.now() + budgetMs;
  const pollMs = Math.max(250, Math.min(2000, Math.floor(budgetMs / 8)));
  const registryPath = path.join(dirs.registry, `${name}.json`);

  while (Date.now() < deadline) {
    const reg = readMeshRegistration(name, dirs);
    if (reg) {
      const pid = parsePid(reg.pid);
      const pidOk = !!pid && isPidAlive(pid);
      const expectedOk = !!pid && pidMatchesExpectation(pid, expectedPid);

      let freshEnough = true;
      if (typeof minRegistryMtimeMs === "number" && Number.isFinite(minRegistryMtimeMs)) {
        try {
          const stats = fs.statSync(registryPath);
          freshEnough = stats.mtimeMs >= (minRegistryMtimeMs - 1000);
        } catch {
          freshEnough = false;
        }
      }

      if (pidOk && expectedOk && freshEnough) {
        return reg;
      }
    }
    await sleep(Math.min(pollMs, Math.max(50, deadline - Date.now())));
  }

  return null;
}

function formatModelLabel(agent: SpawnedAgent): string {
  if (agent.thinking && !modelHasThinkingSuffix(agent.model)) {
    return `${agent.model}:${agent.thinking}`;
  }
  return agent.model;
}

function resolveThinking(params: CrewParams, defaultThinking: string): string {
  const p = params as Record<string, unknown>;
  if (typeof p.thinking === "string" && p.thinking.trim().length > 0) {
    return p.thinking.trim();
  }
  return defaultThinking;
}

function resolveWorkstream(params: CrewParams): string | null {
  if (typeof params.workstream !== "string") return null;
  const normalized = params.workstream.trim();
  return normalized.length > 0 ? normalized : null;
}

function resolveLines(params: CrewParams, fallback = 50): number {
  const p = params as Record<string, unknown>;
  const lines = typeof p.lines === "number" ? p.lines : fallback;
  if (!Number.isFinite(lines)) return fallback;
  return Math.max(1, Math.min(500, Math.floor(lines)));
}

async function ensureMemory(cwd: string): Promise<ReturnType<typeof getActiveMemoryStore>> {
  const existing = getActiveMemoryStore();
  if (existing && existing.projectDir === cwd) {
    return existing;
  }

  const config = loadCrewConfig(crewStore.getCrewDir(cwd));
  try {
    return await initMemory(cwd, config.orchestrator.memory);
  } catch (error) {
    console.warn(`[pi-messenger][orchestrator] memory init failed: ${error instanceof Error ? error.message : "unknown"}`);
    return null;
  }
}

async function maybeBootstrapMemory(
  cwd: string,
  state: MessengerState,
  dirs: Dirs,
  targetName: string,
  userPrompt: string | undefined,
  topk: number,
  workstream: string | null,
): Promise<number> {
  const query = userPrompt?.trim() ?? "";
  if (!query) return 0;

  const store = await ensureMemory(cwd);
  if (!store || !store.enabled || store.degraded) return 0;

  const recalled = await recall(store, query, {
    topk,
    ...(workstream ? { workstreamFilter: workstream } : {}),
  });
  if (recalled.results.length === 0) return 0;

  const lines = recalled.results.map((entry) => {
    const age = formatDuration(Date.now() - entry.createdAtMs);
    return `- [${entry.agent}, ${age} ago]: ${entry.text}`;
  });

  const message = `## Context from prior work\n${lines.join("\n")}`;
  messengerStore.sendMessageToAgent(state, dirs, targetName, message);
  return recalled.results.length;
}

async function collectSpawnTimeoutDiagnostics(
  name: string,
  model: string,
  thinking: string,
  backend: "tmux" | "headless",
  timeoutMs: number,
  expectedPid: number,
  tmuxPaneId: string | null,
  tmuxWindowId: string | null,
  dirs: Dirs,
): Promise<SpawnTimeoutDiagnostics> {
  const meshRegistration = readMeshRegistration(name, dirs);
  const meshPid = parsePid(meshRegistration?.pid);
  const meshPidRelation = resolvePidRelation(meshPid, expectedPid);
  const notes: string[] = [];

  if (meshRegistration && meshPidRelation === "mismatch") {
    notes.push("mesh_pid_mismatch");
  }

  const expectedPidAliveBeforeKill = isPidAlive(expectedPid);
  const meshPidAliveAtTimeout = meshPid ? isPidAlive(meshPid) : false;
  const tmuxPaneTail = backend === "tmux"
    ? captureTmuxPaneTail(tmuxPaneId, SPAWN_DIAGNOSTIC_TMUX_LINES)
    : null;

  return {
    name,
    model,
    thinking,
    backend,
    timeoutMs,
    expectedPid,
    meshPid,
    meshPidRelation,
    expectedPidAliveBeforeKill,
    expectedPidAliveAfterKill: expectedPidAliveBeforeKill,
    meshPidAliveAtTimeout,
    pidSnapshotExpected: capturePidSnapshot(expectedPid),
    pidSnapshotMesh: meshPid ? capturePidSnapshot(meshPid) : null,
    meshRegistration,
    tmuxPaneId,
    tmuxWindowId,
    tmuxPaneTail,
    headlessTail: backend === "headless"
      ? captureHeadlessTail(name, SPAWN_DIAGNOSTIC_LOG_LINES)
      : [],
    signals: {
      sentSigterm: false,
      exitedAfterSigterm: false,
      sentSigkill: false,
    },
    notes,
    createdAt: new Date().toISOString(),
  };
}

export async function executeSpawn(
  params: CrewParams,
  state: MessengerState,
  dirs: Dirs,
  ctx: ExtensionContext,
) {
  const cwd = ctx.cwd ?? process.cwd();
  const config = loadCrewConfig(crewStore.getCrewDir(cwd));

  const active = getAllSpawned(cwd).filter(agent => agent.status !== "dead");
  if (active.length >= config.orchestrator.maxSpawnedAgents) {
    return result(
      `Error: max spawned agents reached (${active.length}/${config.orchestrator.maxSpawnedAgents}).`,
      { mode: "spawn", error: "limit_reached", maxSpawnedAgents: config.orchestrator.maxSpawnedAgents },
    );
  }

  const requestedProfile = params.profile?.trim();
  const profileModel = requestedProfile
    ? resolveProfileModel(cwd, requestedProfile)
    : null;

  if (requestedProfile && !profileModel) {
    return result(
      `Error: profile '${requestedProfile}' not found (or missing model) in ${path.join(cwd, ".pi", "agents")}.`,
      { mode: "spawn", error: "profile_not_found", profile: requestedProfile },
    );
  }

  const model = params.model?.trim() || profileModel?.model || config.orchestrator.defaultModel;
  const thinking = resolveThinking(params, config.orchestrator.defaultThinking);
  const spawnTimeoutMs = resolveSpawnTimeoutMs(params, config, model, thinking);
  const spawnWorkstream = resolveWorkstream(params);
  const name = resolveSpawnName(params.name, dirs, cwd);

  if (!name) {
    return result(
      "Error: failed to generate a unique agent name after 5 attempts.",
      { mode: "spawn", error: "name_collision" },
    );
  }

  clearInbox(dirs, name);

  const orchestratorName = state.agentName || "orchestrator";
  const initialPrompt = buildInitialPrompt(name, model, orchestratorName, params.prompt);

  const backend = tmuxAvailable() ? "tmux" as const : "headless" as const;
  let pid = 0;
  let tmuxPaneId: string | null = null;
  let tmuxWindowId: string | null = null;

  if (backend === "tmux") {
    try {
      const piArgs: string[] = [];
      pushModelArgs(piArgs, model);
      if (thinking && !modelHasThinkingSuffix(model)) {
        piArgs.push("--thinking", thinking);
      }
      piArgs.push("--extension", EXTENSION_DIR, initialPrompt);

      const command = [
        `PI_AGENT_NAME=${shellEscape(name)}`,
        "pi",
        ...piArgs.map(shellEscape),
      ].join(" ");

      const output = String(execFileSync(
        "tmux",
        ["new-window", "-P", "-F", "#{pane_id} #{window_id} #{pane_pid}", "-n", name, command],
        { encoding: "utf-8" },
      )).trim();

      const [pane, win, panePidRaw] = output.split(/\s+/);
      tmuxPaneId = pane || null;
      tmuxWindowId = win || null;
      pid = Number(panePidRaw) || 0;
    } catch (error) {
      return result(
        `Error: failed to spawn tmux worker: ${error instanceof Error ? error.message : "unknown"}`,
        { mode: "spawn", error: "tmux_spawn_failed" },
      );
    }
  } else {
    const args: string[] = [];
    pushModelArgs(args, model);
    if (thinking && !modelHasThinkingSuffix(model)) {
      args.push("--thinking", thinking);
    }
    args.push(
      "--extension", EXTENSION_DIR,
      "--no-session",
      initialPrompt,
    );

    const proc = spawn("pi", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PI_AGENT_NAME: name },
    });

    pid = proc.pid ?? 0;

    const runtime: HeadlessRuntime = {
      proc,
      logs: [],
    };
    headlessRuntimes.set(name, runtime);

    proc.stdout?.on("data", (chunk) => appendHeadlessLogs(name, String(chunk)));
    proc.stderr?.on("data", (chunk) => appendHeadlessLogs(name, String(chunk)));
    proc.on("close", () => {
      headlessRuntimes.delete(name);
      const current = getSpawned(name, cwd);
      if (current && current.status !== "dead") {
        transitionState(name, "dead", cwd);
        unregisterSpawned(name, cwd);
        logHistory({
          event: "reap",
          agent: name,
          timestamp: new Date().toISOString(),
          details: { reason: "headless_exit" },
        }, cwd);
      }
    });
  }

  const now = Date.now();
  registerSpawned({
    name,
    pid,
    sessionId: "",
    tmuxPaneId,
    tmuxWindowId,
    model,
    thinking,
    status: "spawning",
    spawnedAt: now,
    spawnedBy: orchestratorName,
    assignedTask: null,
    currentWorkstream: spawnWorkstream,
    lastActivityAt: now,
    backend,
  }, cwd);

  const joined = await waitForMeshJoin(name, dirs, spawnTimeoutMs, pid || undefined, now);
  if (!joined) {
    const diagnostics = await collectSpawnTimeoutDiagnostics(
      name,
      model,
      thinking,
      backend,
      spawnTimeoutMs,
      pid,
      tmuxPaneId,
      tmuxWindowId,
      dirs,
    );

    diagnostics.signals.sentSigterm = true;
    safeKill(pid, "SIGTERM");
    diagnostics.signals.exitedAfterSigterm = await waitForProcessExit(pid, 2500);

    if (!diagnostics.signals.exitedAfterSigterm) {
      diagnostics.signals.sentSigkill = true;
      safeKill(pid, "SIGKILL");
    }

    diagnostics.expectedPidAliveAfterKill = isPidAlive(pid);

    const existing = getSpawned(name, cwd);
    if (existing) {
      if (backend === "tmux" && !diagnostics.tmuxPaneTail) {
        diagnostics.tmuxPaneTail = captureTmuxPaneTail(existing.tmuxPaneId, SPAWN_DIAGNOSTIC_TMUX_LINES);
      }
      cleanupTmuxPane(existing);
      transitionState(name, "dead", cwd);
      unregisterSpawned(name, cwd);
    } else if (backend === "tmux" && tmuxPaneId) {
      try {
        execFileSync("tmux", ["kill-pane", "-t", tmuxPaneId], { stdio: "ignore" });
      } catch {
        // ignore
      }
    }

    headlessRuntimes.delete(name);

    const diagnosticsPath = persistSpawnTimeoutDiagnostics(cwd, name, diagnostics);

    logHistory({
      event: "reap",
      agent: name,
      timestamp: new Date().toISOString(),
      details: {
        reason: "spawn_timeout",
        backend,
        model,
        thinking,
        pid,
        timeoutMs: spawnTimeoutMs,
        diagnosticsPath,
        meshPid: diagnostics.meshPid,
        meshPidRelation: diagnostics.meshPidRelation,
      },
    }, cwd);

    const timeoutSeconds = Math.max(1, Math.floor(spawnTimeoutMs / 1000));
    const diagnosticsHint = diagnosticsPath ? ` Diagnostics: ${diagnosticsPath}` : "";

    return result(
      `Error: ${name} did not join the mesh within ${timeoutSeconds}s.${diagnosticsHint}`,
      {
        mode: "spawn",
        error: "spawn_timeout",
        name,
        timeoutMs: spawnTimeoutMs,
        diagnosticsPath,
        meshPid: diagnostics.meshPid,
        meshPidRelation: diagnostics.meshPidRelation,
      },
    );
  }

  const current = getSpawned(name, cwd);
  if (current) {
    registerSpawned({
      ...current,
      pid: parsePid(joined.pid) ?? current.pid,
      sessionId: typeof joined.sessionId === "string" ? joined.sessionId : "",
      status: "joined",
      lastActivityAt: parseLastActivityMs(joined),
    }, cwd);
    transitionState(name, "idle", cwd);
  }

  let memoryInjected = 0;
  if (config.orchestrator.memory.enabled) {
    try {
      memoryInjected = await maybeBootstrapMemory(
        cwd,
        state,
        dirs,
        name,
        params.prompt,
        config.orchestrator.memory.autoInjectTopK,
        spawnWorkstream,
      );
    } catch {
      memoryInjected = 0;
    }
  }

  logHistory({
    event: "spawn",
    agent: name,
    timestamp: new Date().toISOString(),
    details: {
      backend,
      model,
      thinking,
      pid,
      spawnTimeoutMs,
      tmuxPaneId,
      tmuxWindowId,
      memoryInjected,
      profile: profileModel?.profile ?? requestedProfile ?? null,
      profileFile: profileModel?.filePath ?? null,
      workstream: spawnWorkstream,
    },
  }, cwd);
  logFeedEvent(cwd, state.agentName, "message", name, `spawned ${name} (${backend})`);

  const modelLabel = thinking && !modelHasThinkingSuffix(model)
    ? `${model}:${thinking}`
    : model;
  const profileLabel = profileModel ? ` via profile '${profileModel.profile}'` : "";

  return result(
    `Spawned ${name} (${modelLabel}) via ${backend}${profileLabel}. Status: idle.`,
    {
      mode: "spawn",
      name,
      model,
      thinking,
      backend,
      timeoutMs: spawnTimeoutMs,
      tmuxPane: tmuxPaneId,
      tmuxWindow: tmuxWindowId,
      status: "idle",
      memoryInjected,
      profile: profileModel?.profile ?? null,
      profileFile: profileModel?.filePath ?? null,
      workstream: spawnWorkstream,
    },
  );
}

function formatAgentStatusLine(agent: SpawnedAgent, mesh: Record<string, unknown> | null): string {
  const icon: Record<SpawnedAgent["status"], string> = {
    spawning: "🟡",
    joined: "🟢",
    idle: "🟢",
    assigned: "🟢",
    done: "⚪",
    dead: "💀",
  };

  const session = mesh?.session as Record<string, unknown> | undefined;
  const tools = Number(session?.toolCalls ?? 0) || 0;
  const tokens = Number(session?.tokens ?? 0) || 0;
  const tokenText = tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : `${tokens}`;
  const taskText = agent.assignedTask ? `assigned: "${agent.assignedTask}"` : agent.status;
  const workstreamText = agent.currentWorkstream ? ` [${agent.currentWorkstream}]` : "";
  const tmuxText = agent.backend === "tmux"
    ? `tmux:${agent.tmuxPaneId ?? "?"}`
    : "headless";

  return `${icon[agent.status]} ${agent.name} (${formatModelLabel(agent)})${workstreamText} — ${taskText} — ${tools} tools, ${tokenText} tokens — ${tmuxText}`;
}

export async function executeAgentsList(
  state: MessengerState,
  dirs: Dirs,
  ctx: ExtensionContext,
) {
  const cwd = ctx.cwd ?? process.cwd();
  const reaped = reapOrphans(cwd);
  const agents = getAllSpawned(cwd);

  if (agents.length === 0 && reaped.length === 0) {
    return result("# Orchestrator Agents\n\nNo spawned orchestrator agents.", {
      mode: "agents.list",
      agents: [],
      reaped,
      count: 0,
    });
  }

  const lines: string[] = [];
  lines.push(`# Orchestrator Agents (${agents.length} spawned)`);
  lines.push("");

  const details = agents.map(agent => {
    const mesh = readMeshRegistration(agent.name, dirs);
    lines.push(formatAgentStatusLine(agent, mesh));
    return {
      ...agent,
      mesh,
    };
  });

  for (const name of reaped) {
    lines.push(`💀 ${name} — dead (reaped: process exited or mesh entry missing)`);
  }

  return result(lines.join("\n"), {
    mode: "agents.list",
    agents: details,
    reaped,
    count: agents.length,
  });
}

async function captureKillSummaryIfNeeded(
  cwd: string,
  agent: SpawnedAgent,
): Promise<void> {
  const config = loadCrewConfig(crewStore.getCrewDir(cwd));
  if (!config.orchestrator.memory.enabled || !agent.assignedTask) return;

  const store = await ensureMemory(cwd);
  if (!store || !store.enabled || store.degraded) return;

  const summary = `Agent ${agent.name} was killed while assigned: ${agent.assignedTask}. Last known status: ${agent.status}.`;
  await remember(store, summary, {
    agent: agent.name,
    type: "summary",
    source: "agents.kill",
    taskId: agent.assignedTask,
    workstream: agent.currentWorkstream ?? undefined,
  });
}

async function killOne(
  name: string,
  state: MessengerState,
  dirs: Dirs,
  ctx: ExtensionContext,
  opts?: { skipSummary?: boolean },
): Promise<{ ok: boolean; noOp?: boolean; error?: string }> {
  const cwd = ctx.cwd ?? process.cwd();
  const config = loadCrewConfig(crewStore.getCrewDir(cwd));
  const agent = getSpawned(name, cwd);

  if (!agent) {
    return { ok: false, error: "not_found" };
  }

  if (agent.status === "dead" || agent.status === "done") {
    return { ok: true, noOp: true };
  }

  if (!opts?.skipSummary) {
    await captureKillSummaryIfNeeded(cwd, agent);
  }

  transitionState(name, "done", cwd);

  try {
    messengerStore.sendMessageToAgent(
      state,
      dirs,
      name,
      "SHUTDOWN: Release reservations and exit.",
    );
  } catch {
    // best effort
  }

  let exited = await waitForProcessExit(agent.pid, config.orchestrator.gracePeriodMs);
  if (!exited) {
    // Re-fetch state after grace period: another concurrent operation may have
    // transitioned the agent away from "done" during the wait.
    const agentAfterGrace = getSpawned(name, cwd);
    if (!agentAfterGrace || agentAfterGrace.status !== "done") {
      return { ok: true, noOp: true };
    }
    safeKill(agent.pid, "SIGTERM");
    exited = await waitForProcessExit(agent.pid, 5000);
  }
  if (!exited) {
    safeKill(agent.pid, "SIGKILL");
  }

  cleanupTmuxPane(agent);

  transitionState(name, "dead", cwd);
  unregisterSpawned(name, cwd);
  headlessRuntimes.delete(name);

  try {
    fs.unlinkSync(path.join(dirs.registry, `${name}.json`));
  } catch {
    // ignore
  }

  logHistory({
    event: "kill",
    agent: name,
    timestamp: new Date().toISOString(),
    details: { pid: agent.pid, backend: agent.backend },
  }, cwd);
  logFeedEvent(cwd, state.agentName, "message", name, `killed ${name}`);

  return { ok: true };
}

export async function executeAgentsKill(
  params: CrewParams,
  state: MessengerState,
  dirs: Dirs,
  ctx: ExtensionContext,
) {
  if (!params.name) {
    return result("Error: agents.kill requires name.", {
      mode: "agents.kill",
      error: "missing_name",
    });
  }

  const outcome = await killOne(params.name, state, dirs, ctx);
  if (!outcome.ok) {
    return result(`Error: failed to kill ${params.name} (${outcome.error ?? "unknown"}).`, {
      mode: "agents.kill",
      error: outcome.error ?? "kill_failed",
      name: params.name,
    });
  }

  if (outcome.noOp) {
    return result(`${params.name} is already done/dead (no-op).`, {
      mode: "agents.kill",
      name: params.name,
      killed: false,
      noop: true,
    });
  }

  return result(`Killed ${params.name}.`, {
    mode: "agents.kill",
    name: params.name,
    killed: true,
  });
}

export async function executeAgentsKillall(
  state: MessengerState,
  dirs: Dirs,
  ctx: ExtensionContext,
) {
  const cwd = ctx.cwd ?? process.cwd();
  const active = getAllSpawned(cwd).filter(agent => agent.status !== "dead");

  const killed: string[] = [];
  const failed: string[] = [];

  for (const agent of active) {
    const outcome = await killOne(agent.name, state, dirs, ctx);
    if (outcome.ok) {
      if (!outcome.noOp) killed.push(agent.name);
    } else {
      failed.push(agent.name);
    }
  }

  return result(
    `Kill-all complete. Killed: ${killed.length}. Failed: ${failed.length}.`,
    {
      mode: "agents.killall",
      killed,
      failed,
    },
  );
}

export async function executeAgentsLogs(
  params: CrewParams,
  ctx: ExtensionContext,
) {
  const cwd = ctx.cwd ?? process.cwd();
  const lines = resolveLines(params, 50);
  const name = params.name;

  if (!name) {
    return result("Error: agents.logs requires name.", {
      mode: "agents.logs",
      error: "missing_name",
    });
  }

  const agent = getSpawned(name, cwd);
  if (!agent) {
    return result(`Error: agent ${name} not found.`, {
      mode: "agents.logs",
      error: "not_found",
      name,
    });
  }

  if (agent.backend === "tmux") {
    if (!agent.tmuxPaneId) {
      return result(`Error: ${name} has no tmux pane id.`, {
        mode: "agents.logs",
        error: "missing_tmux_pane",
      });
    }

    try {
      const output = String(execFileSync(
        "tmux",
        ["capture-pane", "-t", agent.tmuxPaneId, "-p", "-S", `-${lines}`],
        { encoding: "utf-8" },
      ));

      return result(output.trim() || `(No tmux output for ${name})`, {
        mode: "agents.logs",
        name,
        backend: "tmux",
        lines,
      });
    } catch (error) {
      return result(
        `Error capturing tmux logs for ${name}: ${error instanceof Error ? error.message : "unknown"}`,
        { mode: "agents.logs", error: "tmux_capture_failed", name },
      );
    }
  }

  const runtime = headlessRuntimes.get(name);
  const output = runtime
    ? runtime.logs.slice(-lines).join("\n")
    : "(No headless logs captured for this process in current session)";

  return result(output, {
    mode: "agents.logs",
    name,
    backend: "headless",
    lines,
  });
}

export async function executeAgentsAssign(
  params: CrewParams,
  state: MessengerState,
  dirs: Dirs,
  ctx: ExtensionContext,
) {
  const cwd = ctx.cwd ?? process.cwd();
  const name = params.name;
  const task = params.task?.trim();

  if (!name) {
    return result("Error: agents.assign requires name.", {
      mode: "agents.assign",
      error: "missing_name",
    });
  }

  if (!task) {
    return result("Error: agents.assign requires task.", {
      mode: "agents.assign",
      error: "missing_task",
    });
  }

  const config = loadCrewConfig(crewStore.getCrewDir(cwd));
  const agent = getSpawned(name, cwd);
  if (!agent) {
    return result(`Error: agent ${name} not found.`, {
      mode: "agents.assign",
      error: "not_found",
      name,
    });
  }

  if (agent.status === "assigned") {
    return result("Error: Agent already has a task. Wait for completion or kill.", {
      mode: "agents.assign",
      error: "already_assigned",
      name,
    });
  }

  if (agent.status === "spawning") {
    return result("Error: Agent still starting up.", {
      mode: "agents.assign",
      error: "still_spawning",
      name,
    });
  }

  if (agent.status === "dead" || agent.status === "done") {
    return result("Error: Agent is no longer running.", {
      mode: "agents.assign",
      error: "not_running",
      name,
    });
  }

  if (agent.status === "joined") {
    transitionState(name, "idle", cwd);
  }

  const latest = getSpawned(name, cwd);
  if (!latest || latest.status !== "idle") {
    return result(`Error: ${name} is not idle and cannot receive assignment.`, {
      mode: "agents.assign",
      error: "not_idle",
      name,
      status: latest?.status,
    });
  }

  const workstream = resolveWorkstream(params) ?? latest.currentWorkstream ?? null;

  let memoryContext = "";
  let memoryCount = 0;
  if (config.orchestrator.memory.enabled) {
    try {
      const store = await ensureMemory(cwd);
      if (store && store.enabled && !store.degraded) {
        const recalled = await recall(store, task, {
          topk: config.orchestrator.memory.autoInjectTopK,
          minSimilarity: config.orchestrator.memory.minSimilarity,
          maxTokens: config.orchestrator.memory.maxInjectionTokens,
          ...(workstream ? { workstreamFilter: workstream } : {}),
        });
        if (recalled.results.length > 0) {
          memoryCount = recalled.results.length;
          const lines = recalled.results.map((entry) => {
            const age = formatDuration(Math.max(0, Date.now() - entry.createdAtMs));
            return `- [${entry.agent}, ${age} ago]: ${entry.text}`;
          });
          memoryContext = `## Context from prior work\n${lines.join("\n")}\n\n`;
        }
      }
    } catch {
      memoryCount = 0;
    }
  }

  const workstreamBlock = workstream ? `## Workstream\n${workstream}\n\n` : "";
  const assignmentDM = `# Task Assignment\n\n${workstreamBlock}${memoryContext}## Your Task\n${task}\n\n## When Done\nCall: pi_messenger({ action: "agents.done", summary: "Brief description of what you did" })`;

  try {
    messengerStore.sendMessageToAgent(state, dirs, name, assignmentDM);
  } catch (error) {
    return result(`Error: failed to send assignment to ${name}: ${error instanceof Error ? error.message : "unknown"}`, {
      mode: "agents.assign",
      error: "send_failed",
      name,
    });
  }

  registerSpawned({
    ...latest,
    status: "assigned",
    assignedTask: task,
    currentWorkstream: workstream,
    lastActivityAt: Date.now(),
  }, cwd);

  logHistory({
    event: "assign",
    agent: name,
    timestamp: new Date().toISOString(),
    details: {
      task,
      workstream,
      memoryContextInjected: memoryCount > 0,
      memoryContextCount: memoryCount,
    },
  }, cwd);
  logFeedEvent(cwd, state.agentName, "message", name, `assigned task: ${task.slice(0, 120)}`);

  return result(`Assigned task to ${name}.${memoryCount > 0 ? ` Injected ${memoryCount} memory snippet(s).` : ""}${workstream ? ` (workstream: ${workstream})` : ""}`, {
    mode: "agents.assign",
    name,
    assigned: true,
    task,
    workstream,
    memoryContextInjected: memoryCount > 0,
    memoryContextCount: memoryCount,
  });
}

export async function executeAgentsDone(
  params: CrewParams,
  state: MessengerState,
  dirs: Dirs,
  ctx: ExtensionContext,
) {
  const cwd = ctx.cwd ?? process.cwd();
  const callerName = state.agentName;
  const summary = params.summary?.trim() || "Task completed.";

  const agent = getSpawned(callerName, cwd);
  if (!agent) {
    return result("Error: You are not a spawned orchestrator agent.", {
      mode: "agents.done",
      error: "not_spawned_agent",
      caller: callerName,
    });
  }

  if (agent.status !== "assigned") {
    return result(`Error: Agent is in status '${agent.status}', expected 'assigned'.`, {
      mode: "agents.done",
      error: "invalid_state",
      status: agent.status,
    });
  }

  const config = loadCrewConfig(crewStore.getCrewDir(cwd));

  if (config.orchestrator.memory.enabled) {
    try {
      const store = await ensureMemory(cwd);
      if (store && store.enabled && !store.degraded) {
        await remember(store, summary, {
          agent: callerName,
          type: "summary",
          source: "agents.done",
          taskId: agent.assignedTask ?? undefined,
          workstream: agent.currentWorkstream ?? undefined,
          files: state.session.filesModified,
        });
      }
    } catch {
      // best effort
    }
  }

  try {
    messengerStore.sendMessageToAgent(
      state,
      dirs,
      agent.spawnedBy,
      `✅ ${callerName} completed: ${summary}`,
    );
  } catch {
    // best effort
  }

  logHistory({
    event: "done",
    agent: callerName,
    timestamp: new Date().toISOString(),
    details: { summary, task: agent.assignedTask, autoKill: config.orchestrator.autoKillOnDone },
  }, cwd);

  if (!config.orchestrator.autoKillOnDone) {
    registerSpawned({
      ...agent,
      status: "idle",
      assignedTask: null,
      currentWorkstream: null,
      lastActivityAt: Date.now(),
    }, cwd);

    return result("Marked task done and returned to idle.", {
      mode: "agents.done",
      done: true,
      autoKill: false,
    });
  }

  await sleep(5000);
  await killOne(callerName, state, dirs, ctx, { skipSummary: true });

  return result("Marked task done. Auto-kill executed.", {
    mode: "agents.done",
    done: true,
    autoKill: true,
  });
}

export async function executeAgentsCheck(
  params: CrewParams,
  state: MessengerState,
  dirs: Dirs,
  ctx: ExtensionContext,
) {
  const cwd = ctx.cwd ?? process.cwd();
  const name = params.name;

  if (!name) {
    return result("Error: agents.check requires name.", {
      mode: "agents.check",
      error: "missing_name",
    });
  }

  const agent = getSpawned(name, cwd);
  if (!agent) {
    return result(`Error: agent ${name} not found.`, {
      mode: "agents.check",
      error: "not_found",
      name,
    });
  }

  const alive = isPidAlive(agent.pid);
  if (!alive && agent.status !== "dead") {
    transitionState(name, "dead", cwd);
    unregisterSpawned(name, cwd);
  }

  const mesh = readMeshRegistration(name, dirs);
  const meshSession = mesh?.session as Record<string, unknown> | undefined;
  const meshActivity = mesh?.activity as Record<string, unknown> | undefined;

  const toolCalls = Number(meshSession?.toolCalls ?? 0) || 0;
  const tokens = Number(meshSession?.tokens ?? 0) || 0;
  const tokenText = tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : `${tokens}`;

  const currentActivity = typeof meshActivity?.currentActivity === "string"
    ? meshActivity.currentActivity
    : "(no activity)";

  const lastActivityIso = typeof meshActivity?.lastActivityAt === "string"
    ? meshActivity.lastActivityAt
    : null;
  const lastActivityMs = lastActivityIso ? Date.parse(lastActivityIso) : NaN;
  const activityAgo = Number.isFinite(lastActivityMs)
    ? `${formatDuration(Math.max(0, Date.now() - lastActivityMs))} ago`
    : "unknown";

  const uptime = formatDuration(Math.max(0, Date.now() - agent.spawnedAt));
  const lastChat = state.chatHistory.get(name)?.slice(-1)[0];
  const files = Array.isArray(meshSession?.filesModified)
    ? (meshSession?.filesModified as unknown[]).filter((v): v is string => typeof v === "string")
    : [];

  const lines: string[] = [];
  lines.push(`# ${name}`);
  lines.push(`Status: ${alive ? agent.status : "dead"}`);
  lines.push(`Model: ${formatModelLabel(agent)}`);
  lines.push(`Task: ${agent.assignedTask ?? "(none)"}`);
  lines.push(`Workstream: ${agent.currentWorkstream ?? "(none)"}`);
  lines.push(`Uptime: ${uptime}`);
  lines.push(`Activity: ${currentActivity} (${activityAgo})`);
  lines.push(`Tools: ${toolCalls} calls, ${tokenText} tokens`);
  lines.push(`Last message: ${lastChat ? lastChat.text : "(none)"}`);
  lines.push(`Files modified: ${files.length > 0 ? files.join(", ") : "(none)"}`);
  lines.push(`Backend: ${agent.backend}${agent.tmuxPaneId ? ` (${agent.tmuxPaneId})` : ""}`);

  return result(lines.join("\n"), {
    mode: "agents.check",
    name,
    status: alive ? agent.status : "dead",
    model: formatModelLabel(agent),
    assignedTask: agent.assignedTask,
    workstream: agent.currentWorkstream ?? null,
    uptime,
    activity: {
      current: currentActivity,
      lastActivityAt: lastActivityIso,
      ago: activityAgo,
    },
    usage: {
      toolCalls,
      tokens,
    },
    files,
    lastMessage: lastChat ?? null,
    backend: agent.backend,
    tmuxPane: agent.tmuxPaneId,
  });
}

export async function executeAgentsAttach(
  params: CrewParams,
  ctx: ExtensionContext,
) {
  const cwd = ctx.cwd ?? process.cwd();
  const name = params.name;

  if (!name) {
    return result("Error: agents.attach requires name.", {
      mode: "agents.attach",
      error: "missing_name",
    });
  }

  const agent = getSpawned(name, cwd);
  if (!agent) {
    return result(`Error: agent ${name} not found.`, {
      mode: "agents.attach",
      error: "not_found",
      name,
    });
  }

  if (agent.backend === "headless") {
    return result("Agent is running in headless mode. Use agents.logs instead.", {
      mode: "agents.attach",
      name,
      backend: "headless",
    });
  }

  if (!agent.tmuxWindowId) {
    return result(`Error: ${name} has no tmux window id.`, {
      mode: "agents.attach",
      error: "missing_window_id",
      name,
    });
  }

  const command = `tmux select-window -t ${agent.tmuxWindowId}`;

  if (process.env.TMUX) {
    try {
      execFileSync("tmux", ["select-window", "-t", agent.tmuxWindowId], { stdio: "ignore" });
      return result(`Attached to ${name} in tmux window ${agent.tmuxWindowId}.`, {
        mode: "agents.attach",
        name,
        attached: true,
        command,
      });
    } catch {
      // fall through to command output
    }
  }

  return result(`To attach: ${command}`, {
    mode: "agents.attach",
    name,
    attached: false,
    command,
  });
}

export async function execute(
  op: string,
  params: CrewParams,
  state: MessengerState,
  dirs: Dirs,
  ctx: ExtensionContext,
) {
  switch (op) {
    case "list":
      return executeAgentsList(state, dirs, ctx);

    case "kill":
      return executeAgentsKill(params, state, dirs, ctx);

    case "killall":
      return executeAgentsKillall(state, dirs, ctx);

    case "assign":
      return executeAgentsAssign(params, state, dirs, ctx);

    case "check":
      return executeAgentsCheck(params, state, dirs, ctx);

    case "done":
      return executeAgentsDone(params, state, dirs, ctx);

    case "logs":
      return executeAgentsLogs(params, ctx);

    case "attach":
      return executeAgentsAttach(params, ctx);

    case "memory.stats": {
      const cwd = ctx.cwd ?? process.cwd();
      const store = await ensureMemory(cwd);
      if (!store) {
        return result("Memory store unavailable.", { mode: "agents.memory.stats", available: false });
      }
      const stats = getMemoryStats(store);
      return result(JSON.stringify(stats, null, 2), {
        mode: "agents.memory.stats",
        stats,
      });
    }

    case "memory.reset": {
      const cwd = ctx.cwd ?? process.cwd();
      resetMemory(cwd);
      return result("Orchestrator memory reset.", {
        mode: "agents.memory.reset",
        reset: true,
      });
    }

    default:
      return result(`agents.${op} is not implemented yet.`, {
        mode: `agents.${op}`,
        error: "not_implemented",
      });
  }
}
