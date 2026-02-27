import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTempCrewDirs, type TempCrewDirs } from "../../helpers/temp-dirs.js";

const homedirMock = vi.hoisted(() => vi.fn());

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: homedirMock,
  };
});

async function loadIngestionModule() {
  vi.resetModules();
  return import("../../../crew/data/ingestion.js");
}

describe("crew/data/ingestion", () => {
  let dirs: TempCrewDirs;

  beforeEach(() => {
    dirs = createTempCrewDirs();
    homedirMock.mockReset();
    homedirMock.mockReturnValue(dirs.root);
  });

  it("writes production events with full storage and training inclusion", async () => {
    const ingestion = await loadIngestionModule();

    ingestion.initializeDataSessionTags(dirs.cwd, {
      sessionId: "session-1",
      project: "bergomi2",
      runType: "production",
    });

    const result = ingestion.ingestDataEvent(dirs.cwd, {
      source: "dm.send",
      eventType: "message",
      actor: "Architect",
      target: "Builder",
      text: "Implemented task-3 in src/model.ts and added regression tests.",
    });

    expect(result.ok).toBe(true);
    expect(result.path).toContain(path.join("events", "production_work"));

    const content = fs.readFileSync(result.path!, "utf-8").trim();
    const parsed = JSON.parse(content);

    expect(parsed.project).toBe("bergomi2");
    expect(parsed.runType).toBe("production");
    expect(parsed.category).toBe("production_work");
    expect(parsed.storage).toBe("full");
    expect(parsed.includeInTraining).toBe(true);
    expect(parsed.text).toContain("Implemented task-3");
  });

  it("classifies smoke runs as summary-only non-training data", async () => {
    const ingestion = await loadIngestionModule();

    ingestion.initializeDataSessionTags(dirs.cwd, {
      sessionId: "session-2",
      project: "bergomi2",
      runType: "smoke",
    });

    const result = ingestion.ingestDataEvent(dirs.cwd, {
      source: "system",
      eventType: "probe",
      text: "Smoke probe run for spawn timeout diagnostics and retry behavior.",
    });

    expect(result.ok).toBe(true);

    const content = fs.readFileSync(result.path!, "utf-8").trim();
    const parsed = JSON.parse(content);

    expect(parsed.category).toBe("smoke_test");
    expect(parsed.storage).toBe("summary");
    expect(parsed.includeInTraining).toBe(false);
    expect(parsed.text.length).toBeLessThanOrEqual(280);
  });

  it("classifies off-topic content and drops payload text", async () => {
    const ingestion = await loadIngestionModule();

    ingestion.initializeDataSessionTags(dirs.cwd, {
      sessionId: "session-3",
      project: "bergomi2",
      runType: "production",
    });

    const result = ingestion.ingestDataEvent(dirs.cwd, {
      source: "dm.send",
      eventType: "message",
      actor: "Architect",
      target: "Builder",
      text: "Can you explain how dspy works and give me a tutorial?",
    });

    expect(result.ok).toBe(true);

    const content = fs.readFileSync(result.path!, "utf-8").trim();
    const parsed = JSON.parse(content);

    expect(parsed.category).toBe("off_topic");
    expect(parsed.storage).toBe("drop");
    expect(parsed.includeInTraining).toBe(false);
    expect(parsed.text).toBeUndefined();
    expect(parsed.summary).toBeUndefined();
    expect(parsed.hash).toBeTypeOf("string");
  });

  it("deduplicates identical events within the dedupe window", async () => {
    const ingestion = await loadIngestionModule();

    ingestion.initializeDataSessionTags(dirs.cwd, {
      sessionId: "session-4",
      project: "bergomi2",
      runType: "production",
    });

    const first = ingestion.ingestDataEvent(dirs.cwd, {
      source: "feed",
      eventType: "message",
      actor: "A",
      target: "B",
      text: "Assigned task task-9",
    });

    const second = ingestion.ingestDataEvent(dirs.cwd, {
      source: "feed",
      eventType: "message",
      actor: "A",
      target: "B",
      text: "Assigned task task-9",
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.skipped).toBe(true);
    expect(second.reason).toBe("duplicate_in_window");

    const content = fs.readFileSync(first.path!, "utf-8").trim().split("\n");
    expect(content).toHaveLength(1);
  });
});
