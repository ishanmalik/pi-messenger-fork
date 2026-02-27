/**
 * Crew - Configuration Loading
 * 
 * Loads and merges user-level and project-level configuration.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { MaxOutputConfig } from "./truncate.js";

export type CoordinationLevel = "none" | "minimal" | "moderate" | "chatty";

export type DataCategory = "production_work" | "smoke_test" | "off_topic" | "ops_debug";
export type DataStorageMode = "full" | "summary" | "drop";
export type TrainingInclusionMode = "include" | "exclude";
export type DataRunType = "production" | "smoke" | "research" | "debug";

export interface DataPolicyRule {
  storage: DataStorageMode;
  training: TrainingInclusionMode;
  retentionDays: number;
}

export interface DataPolicyConfig {
  enabled: boolean;
  strictProjectFilter: boolean;
  allowedProjects: string[];
  defaultProject: string;
  defaultCategory: DataCategory;
  defaultRunType: DataRunType;
  categories: Record<DataCategory, DataPolicyRule>;
  heuristics: {
    smokeKeywords: string[];
    offTopicKeywords: string[];
  };
  ingestion: {
    dedupeWindowMs: number;
    summaryMaxChars: number;
  };
  classifier: {
    enabled: boolean;
    confidenceThreshold: number;
  };
  progress: {
    maxRawLines: number;
    keepRecentLines: number;
  };
  retention: {
    janitorIntervalMs: number;
    historyDays: number;
    diagnosticsDays: number;
    artifactsDays: number;
  };
  export: {
    format: "jsonl";
    includeDroppedMetadata: boolean;
  };
}

const USER_CONFIG_PATH = path.join(os.homedir(), ".pi", "agent", "pi-messenger.json");
const PROJECT_CONFIG_FILE = "config.json";

const COORDINATION_LEVELS: CoordinationLevel[] = ["none", "minimal", "moderate", "chatty"];

let coordinationOverride: CoordinationLevel | null = null;

export function setCoordinationOverride(level: CoordinationLevel): void {
  coordinationOverride = level;
}

export function getCoordinationOverride(): CoordinationLevel | null {
  return coordinationOverride;
}

export function cycleCoordinationLevel(current: CoordinationLevel): CoordinationLevel {
  const idx = COORDINATION_LEVELS.indexOf(current);
  return COORDINATION_LEVELS[(idx + 1) % COORDINATION_LEVELS.length];
}

export interface CrewConfig {
  models?: {
    planner?: string;
    worker?: string;
    reviewer?: string;
    analyst?: string;
  };
  thinking?: {
    planner?: string;
    worker?: string;
    reviewer?: string;
    analyst?: string;
  };
  concurrency: {
    workers: number;
    max: number;
  };
  truncation: {
    planners: MaxOutputConfig;
    workers: MaxOutputConfig;
    reviewers: MaxOutputConfig;
    analysts: MaxOutputConfig;
  };
  artifacts: {
    enabled: boolean;
    cleanupDays: number;
  };
  memory: { enabled: boolean };
  dataPolicy: DataPolicyConfig;
  planSync: { enabled: boolean };
  review: { enabled: boolean; maxIterations: number };
  planning: { maxPasses: number };
  work: {
    maxAttemptsPerTask: number;
    maxWaves: number;
    stopOnBlock: boolean;
    env?: Record<string, string>;
    shutdownGracePeriodMs?: number;
  };
  dependencies: "advisory" | "strict";
  coordination: CoordinationLevel;
  messageBudgets: Record<CoordinationLevel, number>;
  orchestrator: {
    defaultModel: string;
    defaultThinking: string;
    idleTimeoutMs: number;
    autoKillOnDone: boolean;
    gracePeriodMs: number;
    maxSpawnedAgents: number;
    spawnTimeoutMs: number;
    spawnTimeoutMaxMs: number;
    spawnTimeoutSlowModelMultiplier: number;
    spawnTimeoutHighThinkingMultiplier: number;
    messageBudget: number;
    memory: {
      enabled: boolean;
      embeddingModel: string;
      embeddingProvider: string;
      dimensions: number;
      maxEntries: number;
      autoInjectTopK: number;
      minSimilarity: number;
      maxInjectionTokens: number;
      embeddingTimeoutMs: number;
      ttlDays: {
        message: number;
        discovery: number;
        summary: number;
        decision: number;
      };
    };
  };
}

const DEFAULT_CONFIG: CrewConfig = {
  concurrency: {
    workers: 2,
    max: 10,
  },
  truncation: {
    planners: { bytes: 204800, lines: 5000 },
    workers: { bytes: 204800, lines: 5000 },
    reviewers: { bytes: 102400, lines: 2000 },
    analysts: { bytes: 102400, lines: 2000 },
  },
  artifacts: { enabled: true, cleanupDays: 7 },
  memory: { enabled: false },
  dataPolicy: {
    enabled: true,
    strictProjectFilter: true,
    allowedProjects: [],
    defaultProject: "",
    defaultCategory: "production_work",
    defaultRunType: "production",
    categories: {
      production_work: { storage: "full", training: "include", retentionDays: 3650 },
      smoke_test: { storage: "summary", training: "exclude", retentionDays: 14 },
      off_topic: { storage: "drop", training: "exclude", retentionDays: 3 },
      ops_debug: { storage: "summary", training: "exclude", retentionDays: 30 },
    },
    heuristics: {
      smokeKeywords: ["smoke", "probe", "tmp", "dummy", "sandbox", "test harness"],
      offTopicKeywords: ["dspy", "how does", "what is", "general question", "unrelated", "tutorial"],
    },
    ingestion: {
      dedupeWindowMs: 10000,
      summaryMaxChars: 280,
    },
    classifier: {
      enabled: true,
      confidenceThreshold: 0.6,
    },
    progress: {
      maxRawLines: 200,
      keepRecentLines: 80,
    },
    retention: {
      janitorIntervalMs: 3600000,
      historyDays: 30,
      diagnosticsDays: 14,
      artifactsDays: 7,
    },
    export: {
      format: "jsonl",
      includeDroppedMetadata: false,
    },
  },
  planSync: { enabled: false },
  review: { enabled: true, maxIterations: 3 },
  planning: { maxPasses: 1 },
  work: { maxAttemptsPerTask: 5, maxWaves: 50, stopOnBlock: false, shutdownGracePeriodMs: 30000 },
  dependencies: "advisory",
  coordination: "chatty",
  messageBudgets: { none: 0, minimal: 2, moderate: 5, chatty: 10 },
  orchestrator: {
    defaultModel: "anthropic/claude-sonnet-4-6",
    defaultThinking: "high",
    idleTimeoutMs: 300000,
    autoKillOnDone: true,
    gracePeriodMs: 15000,
    maxSpawnedAgents: 5,
    spawnTimeoutMs: 30000,
    spawnTimeoutMaxMs: 180000,
    spawnTimeoutSlowModelMultiplier: 1.75,
    spawnTimeoutHighThinkingMultiplier: 1.5,
    messageBudget: 100,
    memory: {
      enabled: true,
      embeddingModel: "gemini-embedding-001",
      embeddingProvider: "google",
      dimensions: 1536,
      maxEntries: 10000,
      autoInjectTopK: 3,
      minSimilarity: 0.3,
      maxInjectionTokens: 2000,
      embeddingTimeoutMs: 2000,
      ttlDays: {
        message: 7,
        discovery: 30,
        summary: 90,
        decision: 90,
      },
    },
  },
};

function loadJson(filePath: string): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return {};
  }
}

function deepMerge<T extends object>(target: T, ...sources: Partial<T>[]): T {
  const result: Record<string, unknown> = target && typeof target === "object"
    ? { ...(target as Record<string, unknown>) }
    : {};
  for (const source of sources) {
    const src = source as Record<string, unknown>;
    for (const key of Object.keys(src)) {
      const targetVal = result[key];
      const sourceVal = src[key];
      if (sourceVal && typeof sourceVal === "object" && !Array.isArray(sourceVal)) {
        const base = targetVal && typeof targetVal === "object" && !Array.isArray(targetVal)
          ? targetVal as object
          : {};
        result[key] = deepMerge(base, sourceVal as object);
      } else if (sourceVal !== undefined) {
        result[key] = sourceVal;
      }
    }
  }
  return result as T;
}

/**
 * Load crew configuration with priority: defaults <- user <- project
 */
export function loadCrewConfig(crewDir: string): CrewConfig {
  // User-level config (from ~/.pi/agent/pi-messenger.json -> crew section)
  const userConfig = loadJson(USER_CONFIG_PATH);
  const userCrewConfig = (userConfig.crew ?? {}) as Partial<CrewConfig>;

  // Project-level config (from .pi/messenger/crew/config.json)
  const projectConfig = loadJson(path.join(crewDir, PROJECT_CONFIG_FILE)) as Partial<CrewConfig>;

  // Merge: defaults <- user <- project <- runtime override
  const merged = deepMerge(DEFAULT_CONFIG, userCrewConfig, projectConfig);
  if (coordinationOverride !== null) {
    merged.coordination = coordinationOverride;
  }
  return merged;
}

export function getTruncationForRole(config: CrewConfig, role: string): MaxOutputConfig {
  switch (role) {
    case "planner": return config.truncation.planners;
    case "worker": return config.truncation.workers;
    case "reviewer": return config.truncation.reviewers;
    case "analyst": return config.truncation.analysts;
    default: return config.truncation.workers;
  }
}

export interface DataPolicyDecision {
  category: DataCategory;
  storage: DataStorageMode;
  retentionDays: number;
  includeInTraining: boolean;
}

export function isProjectAllowedByDataPolicy(policy: DataPolicyConfig, project: string | undefined): boolean {
  if (!policy.strictProjectFilter) return true;

  const normalized = (project ?? "").trim();
  const defaultProject = policy.defaultProject.trim();

  if (policy.allowedProjects.length === 0 && defaultProject.length === 0) {
    return true;
  }

  if (!normalized) {
    return policy.allowedProjects.length === 0 && defaultProject.length === 0;
  }

  if (policy.allowedProjects.length === 0) {
    return normalized === defaultProject;
  }

  return policy.allowedProjects.includes(normalized);
}

export function resolveDataPolicyDecision(
  policy: DataPolicyConfig,
  category: DataCategory | undefined,
  project?: string,
): DataPolicyDecision {
  const effectiveCategory = category ?? policy.defaultCategory;
  const fallback = policy.categories[policy.defaultCategory];
  const rule = policy.categories[effectiveCategory] ?? fallback;

  const includeInTraining = rule.training === "include"
    && isProjectAllowedByDataPolicy(policy, project);

  return {
    category: effectiveCategory,
    storage: rule.storage,
    retentionDays: rule.retentionDays,
    includeInTraining,
  };
}
