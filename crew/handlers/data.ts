import * as path from "node:path";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { CrewParams } from "../types.js";
import { result } from "../utils/result.js";
import { initializeDataSessionTags, setSessionDataTags } from "../data/ingestion.js";
import { getDataStorageStats, exportTrainingCorpus } from "../data/export.js";
import { runDataRetentionJanitor } from "../data/retention.js";
import { loadCrewConfig } from "../utils/config.js";

function resolveRunType(value: unknown): "production" | "smoke" | "research" | "debug" | undefined {
  if (value === "production" || value === "smoke" || value === "research" || value === "debug") {
    return value;
  }
  return undefined;
}

function parseMinQuality(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.min(1, value));
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return Math.max(0, Math.min(1, parsed));
    }
  }
  return undefined;
}

export async function execute(op: string, params: CrewParams, ctx: ExtensionContext) {
  const cwd = ctx.cwd ?? process.cwd();

  switch (op) {
    case "session": {
      const runType = resolveRunType(params.runType);
      const session = setSessionDataTags(cwd, {
        ...(params.project ? { project: params.project } : {}),
        ...(runType ? { runType } : {}),
      });

      return result(
        `Data session tags updated. project=${session.project}, runType=${session.runType}, sessionId=${session.sessionId}`,
        {
          mode: "data.session",
          session,
        },
      );
    }

    case "stats": {
      initializeDataSessionTags(cwd);
      const stats = getDataStorageStats(cwd);
      const text = [
        "# Data Stats",
        `Events: ${stats.eventCount}`,
        `Training-eligible: ${stats.trainingEligible}`,
        `Disk usage: ${stats.diskUsageBytes} bytes`,
        `Data root: ${stats.dataRoot}`,
        "",
        "## By Category",
        ...Object.entries(stats.byCategory).map(([k, v]) => `- ${k}: ${v}`),
        "",
        "## By Project",
        ...Object.entries(stats.byProject).map(([k, v]) => `- ${k}: ${v}`),
        "",
        "## By Run Type",
        ...Object.entries(stats.byRunType).map(([k, v]) => `- ${k}: ${v}`),
      ].join("\n");

      return result(text, {
        mode: "data.stats",
        stats,
      });
    }

    case "export": {
      initializeDataSessionTags(cwd);
      const outPath = params.out?.trim();
      const minQuality = parseMinQuality(params.minQualityScore);
      const exported = exportTrainingCorpus(cwd, {
        ...(params.project ? { project: params.project } : {}),
        ...(outPath ? { outPath: path.isAbsolute(outPath) ? outPath : path.join(cwd, outPath) } : {}),
        ...(typeof params.includeDroppedMetadata === "boolean" ? { includeDroppedMetadata: params.includeDroppedMetadata } : {}),
        ...(typeof minQuality === "number" ? { minQualityScore: minQuality } : {}),
      });

      return result(
        `Training corpus exported to ${exported.outPath} (${exported.writtenEvents}/${exported.totalEventsScanned} events).`,
        {
          mode: "data.export",
          export: exported,
        },
      );
    }

    case "retention": {
      const config = loadCrewConfig(path.join(cwd, ".pi", "messenger", "crew"));
      const summary = runDataRetentionJanitor(cwd, config);

      return result(
        `Retention run complete. canonical=${summary.removedCanonicalFiles}, history_pruned=${summary.prunedHistoryLines}, diagnostics=${summary.removedDiagnostics}, artifacts=${summary.removedArtifacts}, compacted_progress=${summary.compactedProgressFiles}.`,
        {
          mode: "data.retention",
          summary,
        },
      );
    }

    default:
      return result(`data.${op} is not implemented.`, {
        mode: `data.${op}`,
        error: "not_implemented",
      });
  }
}
