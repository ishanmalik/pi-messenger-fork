import * as fs from "node:fs";
import * as path from "node:path";
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MessengerState, Dirs } from "../../../lib.js";
import { createTempCrewDirs, type TempCrewDirs } from "../../helpers/temp-dirs.js";
import { createMockContext } from "../../helpers/mock-context.js";

interface FakeProc extends EventEmitter {
  pid: number;
  stdout: EventEmitter;
  stderr: EventEmitter;
}

interface StoredMemory {
  text: string;
  agent: string;
  source: string;
  workstream: string | null;
  taskId: string | null;
  createdAtMs: number;
}

function createDirs(cwd: string): Dirs {
  const base = path.join(cwd, ".pi", "messenger");
  const registry = path.join(base, "registry");
  const inbox = path.join(base, "inbox");
  fs.mkdirSync(registry, { recursive: true });
  fs.mkdirSync(inbox, { recursive: true });
  return { base, registry, inbox };
}

function createState(agentName: string): MessengerState {
  return {
    agentName,
    registered: true,
    watcher: null,
    watcherRetries: 0,
    watcherRetryTimer: null,
    watcherDebounceTimer: null,
    reservations: [],
    chatHistory: new Map(),
    unreadCounts: new Map(),
    broadcastHistory: [],
    seenSenders: new Map(),
    model: "test-model",
    scopeToFolder: false,
    isHuman: false,
    session: { toolCalls: 0, tokens: 0, filesModified: [] },
    activity: { lastActivityAt: new Date().toISOString() },
    customStatus: false,
    registryFlushTimer: null,
    sessionStartedAt: new Date().toISOString(),
  };
}

function latestInboxMessageText(dirs: Dirs, name: string): string {
  const inboxDir = path.join(dirs.inbox, name);
  const files = fs.existsSync(inboxDir)
    ? fs.readdirSync(inboxDir).filter(f => f.endsWith(".json")).sort()
    : [];
  if (files.length === 0) return "";
  const latest = files[files.length - 1];
  const payload = JSON.parse(fs.readFileSync(path.join(inboxDir, latest), "utf-8")) as { text?: string };
  return payload.text ?? "";
}

describe("crew/orchestrator smoke", () => {
  let dirs: TempCrewDirs;

  beforeEach(() => {
    dirs = createTempCrewDirs();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("spawn -> join -> assign -> dm -> kill/respawn -> memory recall", async () => {
    const messengerDirs = createDirs(dirs.cwd);
    const ctx = createMockContext(dirs.cwd);
    const orchestratorState = createState("Boss");

    fs.writeFileSync(path.join(dirs.crewDir, "config.json"), JSON.stringify({
      orchestrator: {
        autoKillOnDone: false,
        gracePeriodMs: 10,
        spawnTimeoutMs: 1200,
        spawnTimeoutMaxMs: 10000,
      },
    }, null, 2));

    const memory: StoredMemory[] = [];
    const memoryStore = {
      enabled: true,
      degraded: false,
      reason: undefined,
      projectDir: dirs.cwd,
      collectionPath: path.join(dirs.cwd, ".pi", "messenger", "orchestrator", "memory"),
      config: {
        enabled: true,
        embeddingModel: "gemini-embedding-001",
        embeddingProvider: "google",
        dimensions: 1536,
        maxEntries: 1000,
        autoInjectTopK: 3,
        minSimilarity: 0.2,
        maxInjectionTokens: 1200,
        embeddingTimeoutMs: 2000,
        ttlDays: {
          message: 7,
          discovery: 30,
          summary: 90,
          decision: 90,
        },
      },
      collection: null,
      consecutiveEmbeddingFailures: 0,
      breakerOpenUntil: 0,
      lastError: undefined,
    };

    vi.doMock("../../../crew/orchestrator/memory.js", () => ({
      getActiveMemoryStore: () => memoryStore,
      initMemory: async () => memoryStore,
      remember: async (
        _store: unknown,
        text: string,
        metadata: { agent: string; source: string; workstream?: string; taskId?: string },
      ) => {
        memory.push({
          text,
          agent: metadata.agent,
          source: metadata.source,
          workstream: metadata.workstream ?? null,
          taskId: metadata.taskId ?? null,
          createdAtMs: Date.now(),
        });
        return { ok: true };
      },
      recall: async (
        _store: unknown,
        _query: string,
        options?: { topk?: number; workstreamFilter?: string },
      ) => {
        const filtered = memory
          .filter(entry => !options?.workstreamFilter || entry.workstream === options.workstreamFilter)
          .slice(-(options?.topk ?? 3))
          .reverse();

        return {
          results: filtered.map((entry, idx) => ({
            id: `m-${idx}`,
            text: entry.text,
            agent: entry.agent,
            type: "summary" as const,
            source: entry.source,
            timestamp: new Date(entry.createdAtMs).toISOString(),
            createdAtMs: entry.createdAtMs,
            taskId: entry.taskId ?? undefined,
            workstream: entry.workstream ?? undefined,
            files: [],
            contentHash: `hash-${idx}`,
            similarity: 0.95,
            relevance: 0.95,
          })),
        };
      },
      resetMemory: () => {
        memory.splice(0, memory.length);
      },
      getMemoryStats: () => ({
        enabled: true,
        degraded: false,
        reason: undefined,
        docCount: memory.length,
        byType: { message: 0, discovery: 0, summary: memory.length, decision: 0 },
        byAgent: {},
        byWorkstream: {},
        circuitBreakerOpen: false,
        circuitBreakerOpenUntil: null,
        circuitBreakerSecondsRemaining: 0,
        consecutiveEmbeddingFailures: 0,
        dimensions: 1536,
        embeddingModel: "gemini-embedding-001",
        collectionPath: memoryStore.collectionPath,
      }),
    }));

    let pidCounter = 45000;
    const alivePids = new Set<number>();
    const procs = new Map<number, FakeProc>();

    const spawnMock = vi.fn((_command: string, _args: string[], options?: { env?: Record<string, string> }) => {
      const proc = new EventEmitter() as FakeProc;
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();

      const pid = ++pidCounter;
      proc.pid = pid;
      alivePids.add(pid);
      procs.set(pid, proc);

      const name = options?.env?.PI_AGENT_NAME ?? `worker-${pid}`;
      setTimeout(() => {
        const registration = {
          name,
          pid,
          sessionId: `session-${pid}`,
          cwd: dirs.cwd,
          model: "claude-opus-4-6",
          startedAt: new Date().toISOString(),
          isHuman: false,
          session: { toolCalls: 0, tokens: 0, filesModified: [] },
          activity: { lastActivityAt: new Date().toISOString() },
        };
        fs.writeFileSync(
          path.join(messengerDirs.registry, `${name}.json`),
          JSON.stringify(registration, null, 2),
        );
      }, 20);

      return proc;
    });

    const execFileSyncMock = vi.fn(() => {
      throw new Error("tmux unavailable");
    });

    vi.doMock("node:child_process", () => ({
      spawn: spawnMock,
      execFileSync: execFileSyncMock,
    }));

    vi.spyOn(process, "kill").mockImplementation(((rawPid: number, signal?: NodeJS.Signals | 0) => {
      const pid = Number(rawPid);
      if (!Number.isFinite(pid) || pid <= 0) {
        const error = new Error("ESRCH") as NodeJS.ErrnoException;
        error.code = "ESRCH";
        throw error;
      }

      if (signal === 0 || signal === undefined) {
        if (!alivePids.has(pid)) {
          const error = new Error("ESRCH") as NodeJS.ErrnoException;
          error.code = "ESRCH";
          throw error;
        }
        return true;
      }

      if (!alivePids.has(pid)) {
        const error = new Error("ESRCH") as NodeJS.ErrnoException;
        error.code = "ESRCH";
        throw error;
      }

      alivePids.delete(pid);
      const proc = procs.get(pid);
      if (proc) {
        queueMicrotask(() => {
          proc.emit("exit", signal === "SIGKILL" ? 137 : 143);
          proc.emit("close", signal === "SIGKILL" ? 137 : 143);
        });
      }

      return true;
    }) as typeof process.kill);

    const orchestrator = await import("../../../crew/handlers/orchestrator.js");
    const messengerStore = await import("../../../store.js");

    const spawn1 = await orchestrator.executeSpawn(
      { name: "SmokeWorker", model: "anthropic/claude-opus-4-6", thinking: "medium" },
      orchestratorState,
      messengerDirs,
      ctx,
    );

    expect((spawn1.details as { status?: string }).status).toBe("idle");
    expect(spawnMock).toHaveBeenCalled();

    const firstSpawnArgs = spawnMock.mock.calls[0]?.[1] as string[];
    expect(firstSpawnArgs).toContain("--provider");
    expect(firstSpawnArgs).toContain("anthropic");
    expect(firstSpawnArgs).toContain("--model");
    expect(firstSpawnArgs).toContain("claude-opus-4-6");

    const assign1 = await orchestrator.execute(
      "assign",
      { name: "SmokeWorker", task: "Create smoke file", workstream: "smoke" },
      orchestratorState,
      messengerDirs,
      ctx,
    );
    expect((assign1.details as { assigned?: boolean }).assigned).toBe(true);

    messengerStore.sendMessageToAgent(orchestratorState, messengerDirs, "SmokeWorker", "Ping from orchestrator");
    messengerStore.sendMessageToAgent(createState("SmokeWorker"), messengerDirs, "Boss", "Pong from worker");

    const workerInboxFiles = fs.readdirSync(path.join(messengerDirs.inbox, "SmokeWorker")).filter(f => f.endsWith(".json"));
    const bossInboxFiles = fs.readdirSync(path.join(messengerDirs.inbox, "Boss")).filter(f => f.endsWith(".json"));
    expect(workerInboxFiles.length).toBeGreaterThan(0);
    expect(bossInboxFiles.length).toBeGreaterThan(0);

    const done = await orchestrator.execute(
      "done",
      { summary: "Created /tmp/smoke.txt" },
      createState("SmokeWorker"),
      messengerDirs,
      ctx,
    );
    expect((done.details as { done?: boolean }).done).toBe(true);

    const killed = await orchestrator.execute(
      "kill",
      { name: "SmokeWorker" },
      orchestratorState,
      messengerDirs,
      ctx,
    );
    expect((killed.details as { killed?: boolean }).killed).toBe(true);

    const spawn2 = await orchestrator.executeSpawn(
      { name: "SmokeWorker", model: "anthropic/claude-opus-4-6", thinking: "medium" },
      orchestratorState,
      messengerDirs,
      ctx,
    );
    expect((spawn2.details as { status?: string }).status).toBe("idle");

    const assign2 = await orchestrator.execute(
      "assign",
      { name: "SmokeWorker", task: "Repeat smoke task", workstream: "smoke" },
      orchestratorState,
      messengerDirs,
      ctx,
    );

    const assign2Details = assign2.details as { memoryContextInjected?: boolean; memoryContextCount?: number };
    expect(assign2Details.memoryContextInjected).toBe(true);
    expect((assign2Details.memoryContextCount ?? 0)).toBeGreaterThan(0);

    const latestAssignment = latestInboxMessageText(messengerDirs, "SmokeWorker");
    expect(latestAssignment).toContain("Context from prior work");
    expect(latestAssignment).toContain("Created /tmp/smoke.txt");
  });
});
