import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  registerSpawned,
  getSpawned,
  getAllSpawned,
  transitionState,
  reapOrphans,
  isOrchestrator,
} from "../../../crew/orchestrator/registry.js";
import type { SpawnedAgent } from "../../../crew/orchestrator/types.js";

describe("crew/orchestrator/registry", () => {
  let root: string;
  let cwd: string;
  let prevMessengerDir: string | undefined;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-messenger-orch-reg-"));
    cwd = path.join(root, "project");
    fs.mkdirSync(cwd, { recursive: true });

    const messengerRoot = path.join(root, "messenger-global");
    fs.mkdirSync(path.join(messengerRoot, "registry"), { recursive: true });

    prevMessengerDir = process.env.PI_MESSENGER_DIR;
    process.env.PI_MESSENGER_DIR = messengerRoot;
  });

  afterEach(() => {
    if (prevMessengerDir === undefined) {
      delete process.env.PI_MESSENGER_DIR;
    } else {
      process.env.PI_MESSENGER_DIR = prevMessengerDir;
    }
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  });

  function sample(overrides?: Partial<SpawnedAgent>): SpawnedAgent {
    return {
      name: "Builder",
      pid: process.pid,
      sessionId: "sess-1",
      tmuxPaneId: null,
      tmuxWindowId: null,
      model: "anthropic/claude-sonnet-4-6",
      thinking: "high",
      status: "spawning",
      spawnedAt: Date.now(),
      spawnedBy: "Orchestrator",
      assignedTask: null,
      lastActivityAt: Date.now(),
      backend: "headless",
      ...overrides,
    };
  }

  it("registers and reads spawned agents", () => {
    registerSpawned(sample(), cwd);
    const found = getSpawned("Builder", cwd);

    expect(found).not.toBeNull();
    expect(found?.name).toBe("Builder");
    expect(getAllSpawned(cwd)).toHaveLength(1);
    expect(isOrchestrator()).toBe(true);
  });

  it("enforces lifecycle transitions", () => {
    registerSpawned(sample(), cwd);

    expect(transitionState("Builder", "joined", cwd)).toBe(true);
    expect(transitionState("Builder", "idle", cwd)).toBe(true);
    expect(transitionState("Builder", "assigned", cwd)).toBe(true);
    expect(transitionState("Builder", "done", cwd)).toBe(true);
    expect(transitionState("Builder", "dead", cwd)).toBe(true);

    // invalid: dead -> idle
    expect(transitionState("Builder", "idle", cwd)).toBe(false);
  });

  it("reaps orphaned agents when pid is gone", () => {
    registerSpawned(sample({ name: "Ghost", pid: 999999, status: "idle" }), cwd);

    const reaped = reapOrphans(cwd);
    const filePath = path.join(cwd, ".pi", "messenger", "orchestrator", "agents", "Ghost.json");

    expect(reaped).toEqual(["Ghost"]);
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it("does not reap spawning agents that have not joined mesh yet", () => {
    registerSpawned(sample({ name: "Booting", status: "spawning", pid: process.pid }), cwd);

    const reaped = reapOrphans(cwd);
    const filePath = path.join(cwd, ".pi", "messenger", "orchestrator", "agents", "Booting.json");

    expect(reaped).toEqual([]);
    expect(fs.existsSync(filePath)).toBe(true);
  });
});
