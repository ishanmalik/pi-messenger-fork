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

function writeJson(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

async function loadModules() {
  vi.resetModules();
  const ingestion = await import("../../../crew/data/ingestion.js");
  const exporter = await import("../../../crew/data/export.js");
  const retention = await import("../../../crew/data/retention.js");
  const config = await import("../../../crew/utils/config.js");
  return { ingestion, exporter, retention, config };
}

describe("crew/data export + retention", () => {
  let dirs: TempCrewDirs;

  beforeEach(() => {
    dirs = createTempCrewDirs();
    homedirMock.mockReset();
    homedirMock.mockReturnValue(dirs.root);
  });

  it("exports training corpus as JSONL and filters non-training events", async () => {
    const { ingestion, exporter } = await loadModules();

    ingestion.initializeDataSessionTags(dirs.cwd, {
      sessionId: "session-export",
      project: "bergomi2",
      runType: "production",
    });

    ingestion.ingestDataEvent(dirs.cwd, {
      source: "task.progress",
      eventType: "task.progress",
      actor: "Builder",
      taskId: "task-1",
      text: "Implemented stochastic volatility path generation and tests.",
    });

    ingestion.ingestDataEvent(dirs.cwd, {
      source: "dm.send",
      eventType: "message",
      actor: "Builder",
      target: "Architect",
      text: "How does dspy work?",
    });

    const outPath = path.join(dirs.cwd, "training.jsonl");
    const exportResult = exporter.exportTrainingCorpus(dirs.cwd, {
      project: "bergomi2",
      outPath,
    });

    expect(exportResult.writtenEvents).toBe(1);
    expect(fs.existsSync(outPath)).toBe(true);

    const lines = fs.readFileSync(outPath, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(1);

    const parsed = JSON.parse(lines[0]);
    expect(parsed.includeInTraining).toBe(true);
    expect(parsed.category).toBe("production_work");
  });

  it("retention janitor prunes old diagnostics/history/artifacts and canonical shards", async () => {
    const { retention, config } = await loadModules();

    writeJson(path.join(dirs.crewDir, "config.json"), {
      dataPolicy: {
        categories: {
          smoke_test: {
            retentionDays: 0,
          },
        },
        retention: {
          historyDays: 0,
          diagnosticsDays: 0,
          artifactsDays: 0,
        },
      },
    });

    const oldTs = Date.now() - (5 * 24 * 60 * 60 * 1000);

    const canonicalPath = path.join(dirs.cwd, ".pi", "messenger", "data", "events", "smoke_test", "2020-01-01.jsonl");
    fs.mkdirSync(path.dirname(canonicalPath), { recursive: true });
    fs.writeFileSync(canonicalPath, "{}\n");
    fs.utimesSync(canonicalPath, oldTs / 1000, oldTs / 1000);

    const diagnosticsPath = path.join(dirs.cwd, ".pi", "messenger", "orchestrator", "spawn-diagnostics", "old.json");
    fs.mkdirSync(path.dirname(diagnosticsPath), { recursive: true });
    fs.writeFileSync(diagnosticsPath, "{}\n");
    fs.utimesSync(diagnosticsPath, oldTs / 1000, oldTs / 1000);

    const artifactsPath = path.join(dirs.cwd, ".pi", "messenger", "crew", "artifacts", "old_output.md");
    fs.mkdirSync(path.dirname(artifactsPath), { recursive: true });
    fs.writeFileSync(artifactsPath, "artifact\n");
    fs.utimesSync(artifactsPath, oldTs / 1000, oldTs / 1000);

    const historyPath = path.join(dirs.cwd, ".pi", "messenger", "orchestrator", "history.jsonl");
    fs.mkdirSync(path.dirname(historyPath), { recursive: true });
    fs.writeFileSync(historyPath, `${JSON.stringify({ event: "spawn", timestamp: "2020-01-01T00:00:00.000Z" })}\n`);

    const cfg = config.loadCrewConfig(dirs.crewDir);
    const summary = retention.runDataRetentionJanitor(dirs.cwd, cfg);

    expect(summary.removedCanonicalFiles).toBeGreaterThanOrEqual(1);
    expect(summary.removedDiagnostics).toBeGreaterThanOrEqual(1);
    expect(summary.removedArtifacts).toBeGreaterThanOrEqual(1);
    expect(summary.prunedHistoryLines).toBeGreaterThanOrEqual(1);

    expect(fs.existsSync(canonicalPath)).toBe(false);
    expect(fs.existsSync(diagnosticsPath)).toBe(false);
    expect(fs.existsSync(artifactsPath)).toBe(false);
    expect(fs.readFileSync(historyPath, "utf-8").trim()).toBe("");
  });
});
