import * as fs from "node:fs";
import * as path from "node:path";
import type { CrewConfig, DataCategory } from "../utils/config.js";
import { compactProgressFile } from "./progress.js";

export interface RetentionSummary {
  removedCanonicalFiles: number;
  prunedHistoryLines: number;
  removedDiagnostics: number;
  removedArtifacts: number;
  compactedProgressFiles: number;
}

function ageMs(days: number): number {
  return Math.max(0, days) * 24 * 60 * 60 * 1000;
}

function pruneDirectoryByMtime(dirPath: string, maxAgeMs: number): number {
  if (!fs.existsSync(dirPath)) return 0;
  let removed = 0;
  const now = Date.now();

  for (const file of fs.readdirSync(dirPath)) {
    const filePath = path.join(dirPath, file);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      continue;
    }

    if (stat.isDirectory()) {
      removed += pruneDirectoryByMtime(filePath, maxAgeMs);
      try {
        if (fs.readdirSync(filePath).length === 0) {
          fs.rmdirSync(filePath);
        }
      } catch {
        // ignore
      }
      continue;
    }

    if (!stat.isFile()) continue;
    if (now - stat.mtimeMs <= maxAgeMs) continue;

    try {
      fs.unlinkSync(filePath);
      removed++;
    } catch {
      // ignore
    }
  }

  return removed;
}

function pruneCanonicalEventShards(cwd: string, config: CrewConfig): number {
  const baseDir = path.join(cwd, ".pi", "messenger", "data", "events");
  if (!fs.existsSync(baseDir)) return 0;

  const now = Date.now();
  let removed = 0;
  const categoryDirs = fs.readdirSync(baseDir, { withFileTypes: true });

  for (const entry of categoryDirs) {
    if (!entry.isDirectory()) continue;
    const category = entry.name as DataCategory;
    const rule = config.dataPolicy.categories[category];
    if (!rule) continue;

    const cutoffMs = ageMs(rule.retentionDays);
    const dirPath = path.join(baseDir, entry.name);

    for (const file of fs.readdirSync(dirPath)) {
      if (!file.endsWith(".jsonl")) continue;
      const filePath = path.join(dirPath, file);
      try {
        const stat = fs.statSync(filePath);
        if (now - stat.mtimeMs <= cutoffMs) continue;
        fs.unlinkSync(filePath);
        removed++;
      } catch {
        // ignore
      }
    }

    try {
      if (fs.readdirSync(dirPath).length === 0) {
        fs.rmdirSync(dirPath);
      }
    } catch {
      // ignore
    }
  }

  return removed;
}

function pruneOrchestratorHistory(cwd: string, historyDays: number): number {
  const filePath = path.join(cwd, ".pi", "messenger", "orchestrator", "history.jsonl");
  if (!fs.existsSync(filePath)) return 0;

  const maxAge = ageMs(historyDays);
  const now = Date.now();

  let content = "";
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    return 0;
  }

  const lines = content.split("\n").filter(line => line.trim().length > 0);
  if (lines.length === 0) return 0;

  const kept: string[] = [];
  let removed = 0;

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as { timestamp?: string };
      const ts = typeof parsed.timestamp === "string" ? Date.parse(parsed.timestamp) : NaN;
      if (Number.isFinite(ts) && now - ts > maxAge) {
        removed++;
        continue;
      }
      kept.push(line);
    } catch {
      // Keep malformed lines so we don't lose unknown format data.
      kept.push(line);
    }
  }

  if (removed === 0) return 0;

  try {
    fs.writeFileSync(filePath, kept.join("\n") + (kept.length > 0 ? "\n" : ""));
  } catch {
    return 0;
  }

  return removed;
}

function compactProgressFiles(cwd: string, config: CrewConfig): number {
  const tasksDir = path.join(cwd, ".pi", "messenger", "crew", "tasks");
  if (!fs.existsSync(tasksDir)) return 0;

  let compacted = 0;
  for (const file of fs.readdirSync(tasksDir)) {
    if (!file.endsWith(".progress.md")) continue;

    const result = compactProgressFile(path.join(tasksDir, file), {
      maxRawLines: config.dataPolicy.progress.maxRawLines,
      keepRecentLines: config.dataPolicy.progress.keepRecentLines,
    });

    if (result.compacted) compacted++;
  }

  return compacted;
}

export function runDataRetentionJanitor(cwd: string, config: CrewConfig): RetentionSummary {
  const removedCanonicalFiles = pruneCanonicalEventShards(cwd, config);
  const prunedHistoryLines = pruneOrchestratorHistory(cwd, config.dataPolicy.retention.historyDays);

  const diagnosticsDir = path.join(cwd, ".pi", "messenger", "orchestrator", "spawn-diagnostics");
  const removedDiagnostics = pruneDirectoryByMtime(
    diagnosticsDir,
    ageMs(config.dataPolicy.retention.diagnosticsDays),
  );

  const artifactRetentionDays = Number.isFinite(config.dataPolicy.retention.artifactsDays)
    ? config.dataPolicy.retention.artifactsDays
    : config.artifacts.cleanupDays;
  const artifactsDir = path.join(cwd, ".pi", "messenger", "crew", "artifacts");
  const removedArtifacts = pruneDirectoryByMtime(artifactsDir, ageMs(artifactRetentionDays));

  const compactedProgressFiles = compactProgressFiles(cwd, config);

  return {
    removedCanonicalFiles,
    prunedHistoryLines,
    removedDiagnostics,
    removedArtifacts,
    compactedProgressFiles,
  };
}
