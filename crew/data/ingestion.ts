import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import {
  loadCrewConfig,
  resolveDataPolicyDecision,
  type DataCategory,
  type DataPolicyConfig,
  type DataRunType,
} from "../utils/config.js";
import {
  type CanonicalEvent,
  type IngestEventInput,
  type IngestEventResult,
  type SessionDataTags,
  computeEventHash,
  qualityScore,
  summarizeText,
} from "./schema.js";
import { runDataRetentionJanitor } from "./retention.js";

const recentHashesByCwd = new Map<string, Map<string, number>>();
const janitorLastRunByCwd = new Map<string, number>();

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function readJson<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
  } catch {
    return null;
  }
}

function writeJsonAtomic(filePath: string, data: unknown): void {
  ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  fs.renameSync(tmpPath, filePath);
}

function appendJsonl(filePath: string, data: unknown): void {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, JSON.stringify(data) + "\n");
}

function dataDir(cwd: string): string {
  return path.join(cwd, ".pi", "messenger", "data");
}

function sessionTagPath(cwd: string): string {
  return path.join(dataDir(cwd), "session-tags.json");
}

function normalizeCategory(input: string | undefined, fallback: DataCategory): DataCategory {
  if (input === "production_work" || input === "smoke_test" || input === "off_topic" || input === "ops_debug") {
    return input;
  }
  return fallback;
}

function normalizeRunType(input: string | undefined, fallback: DataRunType): DataRunType {
  if (input === "production" || input === "smoke" || input === "research" || input === "debug") {
    return input;
  }
  return fallback;
}

function normalizeProject(project: string | undefined, cwd: string, policy: DataPolicyConfig): string {
  const fromInput = project?.trim();
  if (fromInput) return fromInput;

  const fromEnv = process.env.PI_DATA_PROJECT?.trim();
  if (fromEnv) return fromEnv;

  if (policy.defaultProject.trim().length > 0) {
    return policy.defaultProject.trim();
  }

  return path.basename(cwd);
}

export function getSessionDataTags(cwd: string): SessionDataTags | null {
  return readJson<SessionDataTags>(sessionTagPath(cwd));
}

export function initializeDataSessionTags(
  cwd: string,
  options?: {
    sessionId?: string;
    project?: string;
    runType?: DataRunType;
    policy?: DataPolicyConfig;
  },
): SessionDataTags {
  const policy = options?.policy
    ?? loadCrewConfig(path.join(cwd, ".pi", "messenger", "crew")).dataPolicy;
  const existing = getSessionDataTags(cwd);

  const now = new Date().toISOString();
  const sessionId = options?.sessionId?.trim()
    || existing?.sessionId
    || `pid-${process.pid}`;

  const project = normalizeProject(options?.project ?? existing?.project, cwd, policy);

  const runType = normalizeRunType(
    options?.runType
      ?? existing?.runType
      ?? process.env.PI_DATA_RUN_TYPE,
    policy.defaultRunType,
  );

  if (
    existing
    && existing.sessionId === sessionId
    && existing.project === project
    && existing.runType === runType
  ) {
    return existing;
  }

  const tags: SessionDataTags = {
    sessionId,
    project,
    runType,
    startedAt: existing?.startedAt ?? now,
    updatedAt: now,
  };

  writeJsonAtomic(sessionTagPath(cwd), tags);
  return tags;
}

export function setSessionDataTags(
  cwd: string,
  patch: {
    project?: string;
    runType?: DataRunType;
    sessionId?: string;
  },
): SessionDataTags {
  const current = initializeDataSessionTags(cwd);
  return initializeDataSessionTags(cwd, {
    sessionId: patch.sessionId ?? current.sessionId,
    project: patch.project ?? current.project,
    runType: patch.runType ?? current.runType,
  });
}

interface Classification {
  category: DataCategory;
  reasonCodes: string[];
  relevanceScore: number;
}

function hasKeyword(text: string, keywords: string[]): string | null {
  const normalized = text.toLowerCase();
  for (const keyword of keywords) {
    const k = keyword.toLowerCase().trim();
    if (!k) continue;
    if (normalized.includes(k)) {
      return keyword;
    }
  }
  return null;
}

function classifyCategory(
  text: string,
  policy: DataPolicyConfig,
  runType: DataRunType,
  explicitCategory?: DataCategory,
): Classification {
  const reasonCodes: string[] = [];
  const trimmed = text.trim();

  if (explicitCategory) {
    reasonCodes.push("explicit_category");
    return {
      category: explicitCategory,
      reasonCodes,
      relevanceScore: explicitCategory === "production_work" ? 0.95 : 0.25,
    };
  }

  if (runType === "smoke") {
    reasonCodes.push("run_type_smoke");
    return { category: "smoke_test", reasonCodes, relevanceScore: 0.25 };
  }

  if (runType === "debug") {
    reasonCodes.push("run_type_debug");
    return { category: "ops_debug", reasonCodes, relevanceScore: 0.4 };
  }

  const smokeKeyword = hasKeyword(trimmed, policy.heuristics.smokeKeywords);
  if (smokeKeyword) {
    reasonCodes.push(`rule_smoke_keyword:${smokeKeyword}`);
    return { category: "smoke_test", reasonCodes, relevanceScore: 0.2 };
  }

  const offTopicKeyword = hasKeyword(trimmed, policy.heuristics.offTopicKeywords);
  if (offTopicKeyword) {
    reasonCodes.push(`rule_off_topic_keyword:${offTopicKeyword}`);
    return { category: "off_topic", reasonCodes, relevanceScore: 0.1 };
  }

  if (!policy.classifier.enabled) {
    reasonCodes.push("classifier_disabled_default_production");
    return { category: "production_work", reasonCodes, relevanceScore: 0.8 };
  }

  // Stage 2 (heuristic model-like pass): prioritize implementation/code signals.
  const hasCodeSignal = /\b(task-|pi_messenger|agent|workstream|commit|diff|test|fix|src\/|\.ts\b|\.py\b)\b/i.test(trimmed);
  const looksGeneralQuestion = /\b(how does|what is|explain|difference between|tutorial|overview)\b/i.test(trimmed);
  const looksOperational = /\b(timeout|spawn|diagnostic|retry|orphan|heartbeat|pid|tmux|headless)\b/i.test(trimmed);

  const threshold = Math.max(0, Math.min(1, policy.classifier.confidenceThreshold || 0.6));
  const offTopicConfidence = looksGeneralQuestion && !hasCodeSignal ? 0.82 : 0.2;
  const opsDebugConfidence = looksOperational && !hasCodeSignal ? 0.72 : 0.2;
  const productionConfidence = hasCodeSignal ? 0.9 : 0.62;

  if (opsDebugConfidence >= threshold && opsDebugConfidence >= offTopicConfidence && opsDebugConfidence >= productionConfidence) {
    reasonCodes.push("classifier_ops_debug");
    return { category: "ops_debug", reasonCodes, relevanceScore: 0.35 };
  }

  if (offTopicConfidence >= threshold && offTopicConfidence > productionConfidence) {
    reasonCodes.push("classifier_off_topic_question");
    return { category: "off_topic", reasonCodes, relevanceScore: 0.15 };
  }

  reasonCodes.push("classifier_production_default");
  return { category: "production_work", reasonCodes, relevanceScore: 0.85 };
}

function eventFilePath(cwd: string, category: DataCategory, date = new Date()): string {
  const stamp = date.toISOString().slice(0, 10);
  return path.join(dataDir(cwd), "events", category, `${stamp}.jsonl`);
}

function shouldSkipDuplicate(cwd: string, hash: string, nowMs: number, dedupeWindowMs: number): boolean {
  let cache = recentHashesByCwd.get(cwd);
  if (!cache) {
    cache = new Map<string, number>();
    recentHashesByCwd.set(cwd, cache);
  }

  // Compact cache opportunistically.
  for (const [key, ts] of cache) {
    if (nowMs - ts > dedupeWindowMs * 5) {
      cache.delete(key);
    }
  }

  const seenAt = cache.get(hash);
  if (seenAt && nowMs - seenAt <= dedupeWindowMs) {
    return true;
  }

  cache.set(hash, nowMs);
  return false;
}

function maybeRunJanitor(cwd: string, config: ReturnType<typeof loadCrewConfig>): void {
  const now = Date.now();
  const interval = Math.max(60000, config.dataPolicy.retention.janitorIntervalMs || 3600000);
  const lastRun = janitorLastRunByCwd.get(cwd) ?? 0;

  if (now - lastRun < interval) return;

  janitorLastRunByCwd.set(cwd, now);
  runDataRetentionJanitor(cwd, config);
}

function sanitizeText(text: string | undefined): string {
  return (text ?? "").replace(/\0/g, "").trim();
}

export function ingestDataEvent(cwd: string, input: IngestEventInput): IngestEventResult {
  try {
    const crewDir = path.join(cwd, ".pi", "messenger", "crew");
    const config = loadCrewConfig(crewDir);
    const policy = config.dataPolicy;

    if (!policy.enabled) {
      return { ok: true, skipped: true, reason: "data_policy_disabled" };
    }

    const session = initializeDataSessionTags(cwd, {
      sessionId: input.sessionId,
      project: input.project,
      runType: input.runType,
      policy,
    });

    const ts = input.ts ?? new Date().toISOString();
    const rawText = sanitizeText(input.text);
    const classification = classifyCategory(rawText, policy, session.runType, input.category);
    const decision = resolveDataPolicyDecision(policy, classification.category, session.project);

    const summary = rawText
      ? summarizeText(rawText, Math.max(40, policy.ingestion.summaryMaxChars || 280))
      : "";

    const storedText = decision.storage === "full"
      ? rawText
      : decision.storage === "summary"
        ? summary
        : undefined;

    // "drop" keeps metadata + hash only (no recoverable text payload).
    const persistedSummary = decision.storage === "drop" ? "" : summary;
    const hashPayloadText = decision.storage === "drop" ? rawText : (storedText ?? summary);

    const hash = computeEventHash({
      source: input.source,
      eventType: input.eventType,
      actor: input.actor,
      target: input.target,
      project: session.project,
      runType: session.runType,
      category: decision.category,
      text: hashPayloadText,
      summary: persistedSummary,
      taskId: input.taskId,
    });

    const nowMs = Date.now();
    if (shouldSkipDuplicate(cwd, hash, nowMs, Math.max(1000, policy.ingestion.dedupeWindowMs || 10000))) {
      return { ok: true, skipped: true, reason: "duplicate_in_window" };
    }

    const event: CanonicalEvent = {
      id: randomUUID(),
      ts,
      source: input.source,
      eventType: input.eventType,
      ...(input.actor ? { actor: input.actor } : {}),
      ...(input.target ? { target: input.target } : {}),
      project: session.project,
      runType: session.runType,
      category: decision.category,
      storage: decision.storage,
      includeInTraining: decision.includeInTraining,
      retentionDays: decision.retentionDays,
      sessionId: session.sessionId,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(input.workstream ? { workstream: input.workstream } : {}),
      ...(storedText ? { text: storedText } : {}),
      ...(persistedSummary ? { summary: persistedSummary } : {}),
      reasonCodes: classification.reasonCodes,
      relevanceScore: Number(classification.relevanceScore.toFixed(3)),
      qualityScore: qualityScore(storedText ?? summary),
      ...(input.metadata ? { metadata: input.metadata } : {}),
      hash,
    };

    const filePath = eventFilePath(cwd, decision.category);
    appendJsonl(filePath, event);

    maybeRunJanitor(cwd, config);

    return { ok: true, event, path: filePath };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : "ingest_failed",
    };
  }
}

export function listCanonicalEventFiles(cwd: string): string[] {
  const base = path.join(dataDir(cwd), "events");
  if (!fs.existsSync(base)) return [];

  const files: string[] = [];
  const categories = fs.readdirSync(base, { withFileTypes: true });
  for (const category of categories) {
    if (!category.isDirectory()) continue;
    const dirPath = path.join(base, category.name);
    for (const file of fs.readdirSync(dirPath)) {
      if (!file.endsWith(".jsonl")) continue;
      files.push(path.join(dirPath, file));
    }
  }

  return files.sort();
}

export function readCanonicalEvents(cwd: string): CanonicalEvent[] {
  const events: CanonicalEvent[] = [];

  for (const filePath of listCanonicalEventFiles(cwd)) {
    let content = "";
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }

    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        events.push(JSON.parse(trimmed) as CanonicalEvent);
      } catch {
        // ignore malformed line
      }
    }
  }

  return events.sort((a, b) => a.ts.localeCompare(b.ts));
}

export function dataRootDir(cwd: string): string {
  return dataDir(cwd);
}
