import { createHash } from "node:crypto";
import type {
  DataCategory,
  DataRunType,
  DataStorageMode,
} from "../utils/config.js";

export type CanonicalSource =
  | "feed"
  | "dm.send"
  | "orchestrator.history"
  | "task.progress"
  | "system";

export interface SessionDataTags {
  sessionId: string;
  project: string;
  runType: DataRunType;
  startedAt: string;
  updatedAt: string;
}

export interface CanonicalEvent {
  id: string;
  ts: string;
  source: CanonicalSource;
  eventType: string;
  actor?: string;
  target?: string;
  project: string;
  runType: DataRunType;
  category: DataCategory;
  storage: DataStorageMode;
  includeInTraining: boolean;
  retentionDays: number;
  sessionId: string;
  taskId?: string;
  workstream?: string;
  text?: string;
  summary?: string;
  reasonCodes: string[];
  relevanceScore: number;
  qualityScore: number;
  metadata?: Record<string, unknown>;
  hash: string;
}

export interface IngestEventInput {
  source: CanonicalSource;
  eventType: string;
  ts?: string;
  actor?: string;
  target?: string;
  text?: string;
  taskId?: string;
  workstream?: string;
  category?: DataCategory;
  project?: string;
  runType?: DataRunType;
  sessionId?: string;
  metadata?: Record<string, unknown>;
}

export interface IngestEventResult {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  event?: CanonicalEvent;
  path?: string;
}

export function summarizeText(input: string, maxChars: number): string {
  const cleaned = input.replace(/\s+/g, " ").trim();
  if (!cleaned) return "";
  if (cleaned.length <= maxChars) return cleaned;
  return cleaned.slice(0, Math.max(0, maxChars - 1)) + "…";
}

export function qualityScore(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;

  let score = 0.5;

  if (trimmed.length >= 40) score += 0.15;
  if (trimmed.length >= 120) score += 0.1;

  const hasCodeSignal = /\b(task-|pi_messenger|function|class|import|export|\.ts\b|\.py\b|commit|test)\b/i.test(trimmed);
  if (hasCodeSignal) score += 0.15;

  const looksSpammy = /(.)\1{6,}|\b(ok|test)\b\s*$/i.test(trimmed);
  if (looksSpammy) score -= 0.25;

  return Math.max(0, Math.min(1, Number(score.toFixed(3))));
}

export function computeEventHash(parts: {
  source: string;
  eventType: string;
  actor?: string;
  target?: string;
  project: string;
  runType: string;
  category: string;
  text?: string;
  summary?: string;
  taskId?: string;
}): string {
  const payload = [
    parts.source,
    parts.eventType,
    parts.actor ?? "",
    parts.target ?? "",
    parts.project,
    parts.runType,
    parts.category,
    parts.taskId ?? "",
    parts.text ?? "",
    parts.summary ?? "",
  ].join("\u241F");

  return createHash("sha256").update(payload).digest("hex");
}
