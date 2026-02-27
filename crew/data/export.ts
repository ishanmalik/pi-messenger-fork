import * as fs from "node:fs";
import * as path from "node:path";
import { loadCrewConfig } from "../utils/config.js";
import { readCanonicalEvents, dataRootDir } from "./ingestion.js";
import type { CanonicalEvent } from "./schema.js";

export interface TrainingExportOptions {
  project?: string;
  outPath?: string;
  includeDroppedMetadata?: boolean;
  minQualityScore?: number;
}

export interface TrainingExportResult {
  outPath: string;
  totalEventsScanned: number;
  writtenEvents: number;
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function defaultExportPath(cwd: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(cwd, ".pi", "messenger", "data", "exports", `training-${stamp}.jsonl`);
}

function shouldIncludeEvent(
  event: CanonicalEvent,
  options: TrainingExportOptions,
): boolean {
  if (!event.includeInTraining) {
    if (!(options.includeDroppedMetadata && event.storage === "drop")) {
      return false;
    }
  }

  if (options.project && event.project !== options.project) {
    return false;
  }

  if (typeof options.minQualityScore === "number" && event.qualityScore < options.minQualityScore) {
    return false;
  }

  return true;
}

export function exportTrainingCorpus(cwd: string, options: TrainingExportOptions = {}): TrainingExportResult {
  const config = loadCrewConfig(path.join(cwd, ".pi", "messenger", "crew"));
  const includeDroppedMetadata = options.includeDroppedMetadata ?? config.dataPolicy.export.includeDroppedMetadata;

  const effectiveOptions: TrainingExportOptions = {
    ...options,
    includeDroppedMetadata,
  };

  const events = readCanonicalEvents(cwd);
  const selected = events.filter(event => shouldIncludeEvent(event, effectiveOptions));

  const outPath = options.outPath?.trim() || defaultExportPath(cwd);
  ensureDir(path.dirname(outPath));

  const lines = selected.map(event => JSON.stringify(event));
  fs.writeFileSync(outPath, lines.join("\n") + (lines.length > 0 ? "\n" : ""));

  return {
    outPath,
    totalEventsScanned: events.length,
    writtenEvents: selected.length,
  };
}

export interface DataStorageStats {
  eventCount: number;
  byCategory: Record<string, number>;
  byProject: Record<string, number>;
  byRunType: Record<string, number>;
  trainingEligible: number;
  diskUsageBytes: number;
  dataRoot: string;
}

function directorySizeBytes(dir: string): number {
  if (!fs.existsSync(dir)) return 0;

  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += directorySizeBytes(entryPath);
      continue;
    }
    if (!entry.isFile()) continue;
    try {
      total += fs.statSync(entryPath).size;
    } catch {
      // ignore
    }
  }

  return total;
}

export function getDataStorageStats(cwd: string): DataStorageStats {
  const events = readCanonicalEvents(cwd);
  const byCategory: Record<string, number> = {};
  const byProject: Record<string, number> = {};
  const byRunType: Record<string, number> = {};

  let trainingEligible = 0;
  for (const event of events) {
    byCategory[event.category] = (byCategory[event.category] ?? 0) + 1;
    byProject[event.project] = (byProject[event.project] ?? 0) + 1;
    byRunType[event.runType] = (byRunType[event.runType] ?? 0) + 1;
    if (event.includeInTraining) {
      trainingEligible += 1;
    }
  }

  const dataRoot = dataRootDir(cwd);

  return {
    eventCount: events.length,
    byCategory,
    byProject,
    byRunType,
    trainingEligible,
    diskUsageBytes: directorySizeBytes(dataRoot),
    dataRoot,
  };
}
