import * as fs from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { join, dirname } from "node:path";
import type { ZVecCollection, ZVecDoc } from "@zvec/zvec";
import { embed } from "./embedding.js";
import type {
  MemoryConfig,
  MemoryStore,
  MemoryType,
  MemoryEntry,
  MemoryStats,
  TtlConfig,
} from "./types.js";

const COLLECTION_NAME = "orchestrator_memory";
const VECTOR_FIELD = "embedding";
const SCHEMA_VERSION = 2;
const CIRCUIT_BREAKER_FAILURES = 3;
const CIRCUIT_BREAKER_COOLDOWN_MS = 60_000;
const MAX_AGENT_SHARE = 0.4;
const CORRUPTION_HINTS = [
  "corrupt",
  "corruption",
  "idmap",
  "manifest",
  "sst",
  "rocksdb",
  "invalid checksum",
  "unable to read",
  "index",
];

let activeStore: MemoryStore | null = null;
let zvecRuntimeCache: Record<string, unknown> | null | undefined;

class SchemaMismatchError extends Error {}
class HealthcheckError extends Error {
  readonly healthError: string;

  constructor(healthError: string) {
    super(`healthcheck_failed: ${healthError}`);
    this.healthError = healthError;
  }
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function writeJsonAtomic(filePath: string, data: unknown): void {
  ensureDir(dirname(filePath));
  const temp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temp, JSON.stringify(data, null, 2));
  fs.renameSync(temp, filePath);
}

function memoryDir(projectDir: string): string {
  return join(projectDir, ".pi", "messenger", "orchestrator", "memory");
}

function metadataPath(collectionPath: string): string {
  return join(collectionPath, "orchestrator-meta.json");
}

function backupRoot(projectDir: string): string {
  return join(projectDir, ".pi", "messenger", "orchestrator", "memory-backups");
}

function timestampTag(date = new Date()): string {
  const iso = date.toISOString();
  return iso.replace(/[:.]/g, "-");
}

function sanitizeSuffix(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64) || "unknown";
}

function safeParseJson<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function parseFiles(raw: unknown): string[] {
  if (typeof raw !== "string" || raw.length === 0) return [];
  const parsed = safeParseJson<unknown>(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((item): item is string => typeof item === "string");
}

function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function escapeFilterValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\"/g, "\\\"");
}

function isCorruptionSignal(reason: string): boolean {
  const normalized = reason.toLowerCase();
  if (normalized.includes("query_failed")) return true;
  return CORRUPTION_HINTS.some(hint => normalized.includes(hint));
}

function backupAndResetCollectionPath(projectDir: string, collectionPath: string, reason: string): string | null {
  if (!fs.existsSync(collectionPath)) return null;

  const backupDir = backupRoot(projectDir);
  ensureDir(backupDir);

  const backupPath = join(
    backupDir,
    `${timestampTag()}-${sanitizeSuffix(reason)}`,
  );

  ensureDir(dirname(backupPath));
  fs.renameSync(collectionPath, backupPath);
  return backupPath;
}

function isErrorWithMessage(error: unknown): error is Error {
  return error instanceof Error && typeof error.message === "string";
}

function isLikelyCorruptionError(error: unknown): boolean {
  if (!isErrorWithMessage(error)) return false;
  if (error instanceof HealthcheckError) {
    return isCorruptionSignal(error.healthError);
  }
  return isCorruptionSignal(error.message);
}

function isMemoryType(value: unknown): value is MemoryType {
  return value === "summary" || value === "message" || value === "decision" || value === "discovery";
}

function asMemoryType(value: unknown): MemoryType {
  return isMemoryType(value) ? value : "message";
}

function approxTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function distanceToSimilarity(distance: unknown): number {
  if (typeof distance !== "number" || !Number.isFinite(distance)) return 0;
  if (distance < 0) return 1;
  return 1 / (1 + distance);
}

function recencyBonus(createdAtMs: number): number {
  const ageMs = Math.max(0, Date.now() - createdAtMs);
  const dayMs = 24 * 60 * 60 * 1000;
  const weekMs = 7 * dayMs;
  if (ageMs >= weekMs) return 0;
  return 0.15 * (1 - (ageMs / weekMs));
}

function breakerOpen(store: MemoryStore): boolean {
  return Date.now() < store.breakerOpenUntil;
}

function markEmbeddingFailure(store: MemoryStore, error: string): void {
  store.lastError = error;
  store.consecutiveEmbeddingFailures += 1;
  if (store.consecutiveEmbeddingFailures >= CIRCUIT_BREAKER_FAILURES) {
    store.breakerOpenUntil = Date.now() + CIRCUIT_BREAKER_COOLDOWN_MS;
  }
}

function markEmbeddingSuccess(store: MemoryStore): void {
  store.consecutiveEmbeddingFailures = 0;
  store.breakerOpenUntil = 0;
}

function defaultStats(store: MemoryStore): MemoryStats {
  return {
    enabled: store.enabled,
    degraded: store.degraded,
    reason: store.reason,
    docCount: 0,
    byType: {
      message: 0,
      discovery: 0,
      summary: 0,
      decision: 0,
    },
    byAgent: {},
    byWorkstream: {},
    circuitBreakerOpen: breakerOpen(store),
    circuitBreakerOpenUntil: store.breakerOpenUntil || null,
    circuitBreakerSecondsRemaining: Math.max(0, Math.ceil((store.breakerOpenUntil - Date.now()) / 1000)),
    consecutiveEmbeddingFailures: store.consecutiveEmbeddingFailures,
    dimensions: store.config.dimensions,
    embeddingModel: store.config.embeddingModel,
    collectionPath: store.collectionPath,
  };
}

function createStore(projectDir: string, config: MemoryConfig): MemoryStore {
  return {
    enabled: config.enabled,
    degraded: !config.enabled,
    reason: config.enabled ? undefined : "memory_disabled",
    projectDir,
    collectionPath: memoryDir(projectDir),
    config,
    collection: null,
    consecutiveEmbeddingFailures: 0,
    breakerOpenUntil: 0,
    lastError: undefined,
  };
}

async function getZvecRuntime(): Promise<Record<string, unknown> | null> {
  if (zvecRuntimeCache !== undefined) return zvecRuntimeCache;
  try {
    const runtime = await import("@zvec/zvec");
    zvecRuntimeCache = runtime as Record<string, unknown>;
  } catch (error) {
    console.warn(`[pi-messenger][orchestrator] zvec unavailable: ${error instanceof Error ? error.message : "unknown error"}`);
    zvecRuntimeCache = null;
  }
  return zvecRuntimeCache;
}

function runtimeOrThrow(runtime: Record<string, unknown>, key: string): unknown {
  const direct = runtime[key];
  if (direct) {
    return direct;
  }

  const nested = (runtime.default as Record<string, unknown> | undefined)?.[key];
  if (nested) {
    return nested;
  }

  throw new Error(`zvec runtime missing ${key}`);
}

function createSchema(runtime: Record<string, unknown>, config: MemoryConfig): unknown {
  const ZVecDataType = runtimeOrThrow(runtime, "ZVecDataType") as Record<string, number>;
  const ZVecIndexType = runtimeOrThrow(runtime, "ZVecIndexType") as Record<string, number>;
  const ZVecMetricType = runtimeOrThrow(runtime, "ZVecMetricType") as Record<string, number>;
  const ZVecCollectionSchema = runtimeOrThrow(runtime, "ZVecCollectionSchema") as new (...args: any[]) => unknown;

  return new ZVecCollectionSchema({
    name: COLLECTION_NAME,
    vectors: {
      name: VECTOR_FIELD,
      dataType: ZVecDataType.VECTOR_FP32,
      dimension: config.dimensions,
      indexParams: {
        indexType: ZVecIndexType.FLAT,
        metricType: ZVecMetricType.COSINE,
      },
    },
    fields: [
      { name: "agent", dataType: ZVecDataType.STRING },
      { name: "type", dataType: ZVecDataType.STRING },
      { name: "source", dataType: ZVecDataType.STRING },
      { name: "timestamp", dataType: ZVecDataType.STRING },
      { name: "createdAtMs", dataType: ZVecDataType.INT64 },
      { name: "taskId", dataType: ZVecDataType.STRING },
      { name: "workstream", dataType: ZVecDataType.STRING },
      { name: "files", dataType: ZVecDataType.STRING },
      { name: "contentHash", dataType: ZVecDataType.STRING },
      { name: "schemaVersion", dataType: ZVecDataType.INT32 },
      { name: "embeddingModel", dataType: ZVecDataType.STRING },
      { name: "embeddingDimensions", dataType: ZVecDataType.INT32 },
      { name: "text", dataType: ZVecDataType.STRING },
    ],
  });
}

function openCollection(
  runtime: Record<string, unknown>,
  collectionPath: string,
  config: MemoryConfig,
): ZVecCollection {
  const ZVecOpen = runtimeOrThrow(runtime, "ZVecOpen") as (path: string) => ZVecCollection;
  const ZVecCreateAndOpen = runtimeOrThrow(runtime, "ZVecCreateAndOpen") as (path: string, schema: unknown) => ZVecCollection;

  const schema = createSchema(runtime, config);

  if (!fs.existsSync(collectionPath)) {
    ensureDir(dirname(collectionPath));
    return ZVecCreateAndOpen(collectionPath, schema);
  }

  try {
    return ZVecOpen(collectionPath);
  } catch {
    return ZVecCreateAndOpen(collectionPath, schema);
  }
}

function validateMetadata(collectionPath: string, config: MemoryConfig): void {
  const filePath = metadataPath(collectionPath);
  const expected = {
    schemaVersion: SCHEMA_VERSION,
    embeddingDimensions: config.dimensions,
    collection: COLLECTION_NAME,
  };

  if (!fs.existsSync(filePath)) {
    writeJsonAtomic(filePath, expected);
    return;
  }

  const raw = fs.readFileSync(filePath, "utf-8");
  const parsed = safeParseJson<Record<string, unknown>>(raw);
  if (!parsed) {
    throw new SchemaMismatchError("Memory metadata is corrupt. Run pi_messenger({ action: \"agents.memory.reset\" }).");
  }

  if (parsed.schemaVersion !== SCHEMA_VERSION) {
    throw new SchemaMismatchError("Memory schema version changed. Run pi_messenger({ action: \"agents.memory.reset\" }).");
  }

  if (parsed.embeddingDimensions !== config.dimensions) {
    throw new SchemaMismatchError(`Memory embedding dimensions mismatch (${parsed.embeddingDimensions} != ${config.dimensions}). Run pi_messenger({ action: \"agents.memory.reset\" }).`);
  }
}

function validateCollectionShape(collection: ZVecCollection, config: MemoryConfig): void {
  let dim: unknown;
  try {
    dim = collection.schema.vector(VECTOR_FIELD)?.dimension;
  } catch {
    throw new SchemaMismatchError("Memory collection missing embedding vector field. Run pi_messenger({ action: \"agents.memory.reset\" }).");
  }

  if (dim !== config.dimensions) {
    throw new SchemaMismatchError(`Memory vector dimension mismatch (${String(dim)} != ${config.dimensions}). Run pi_messenger({ action: \"agents.memory.reset\" }).`);
  }
}

function probeVector(dimensions: number): number[] {
  const vector = new Array<number>(Math.max(1, dimensions)).fill(0);
  vector[0] = 1;
  return vector;
}

function runHealthCheck(store: MemoryStore): { ok: boolean; error?: string } {
  if (!store.collection) {
    return { ok: false, error: "collection_unavailable" };
  }

  const id = `health-${randomUUID()}`;
  const now = Date.now();
  const hash = contentHash(`health:${id}`);
  const vector = probeVector(store.config.dimensions);

  const cleanup = () => {
    try { store.collection?.deleteSync(id); } catch {}
  };

  const queryForInsertedDoc = (): boolean => {
    try {
      const topk = Math.max(8, Math.min(64, Math.max(1, store.collection?.stats?.docCount ?? 0)));
      const byVector = store.collection?.querySync({
        fieldName: VECTOR_FIELD,
        vector,
        topk,
        outputFields: ["contentHash"],
      }) ?? [];

      if (byVector.some(doc => doc.fields?.contentHash === hash)) {
        return true;
      }

      const byScalar = store.collection?.querySync({
        filter: `contentHash = "${escapeFilterValue(hash)}"`,
        topk: 8,
        outputFields: ["contentHash"],
      }) ?? [];

      return byScalar.some(doc => doc.fields?.contentHash === hash);
    } catch {
      return false;
    }
  };

  try {
    const status = store.collection.insertSync({
      id,
      vectors: { [VECTOR_FIELD]: vector },
      fields: {
        agent: "__health__",
        type: "summary",
        source: "healthcheck",
        timestamp: new Date(now).toISOString(),
        createdAtMs: now,
        taskId: "",
        workstream: "",
        files: "[]",
        contentHash: hash,
        schemaVersion: SCHEMA_VERSION,
        embeddingModel: store.config.embeddingModel,
        embeddingDimensions: store.config.dimensions,
        text: "healthcheck",
      },
    }) as { ok?: boolean; message?: string };

    if (!status || status.ok !== true) {
      cleanup();
      return { ok: false, error: status?.message || "insert_failed" };
    }

    if (queryForInsertedDoc()) {
      cleanup();
      return { ok: true };
    }

    try {
      store.collection.optimizeSync();
    } catch {}

    if (queryForInsertedDoc()) {
      cleanup();
      return { ok: true };
    }

    cleanup();
    return { ok: false, error: "query_failed" };
  } catch (error) {
    cleanup();
    return { ok: false, error: error instanceof Error ? error.message : "healthcheck_failed" };
  }
}

function queryAll(store: MemoryStore, outputFields: string[]): ZVecDoc[] {
  if (!store.collection) return [];
  const count = Math.max(0, store.collection.stats?.docCount ?? 0);
  if (count === 0) return [];

  try {
    return store.collection.querySync({
      filter: "createdAtMs >= 0",
      topk: Math.max(1, count),
      outputFields,
    });
  } catch {
    return [];
  }
}

function buildFilter(
  agentFilter?: string,
  typeFilter?: MemoryType[],
  workstreamFilter?: string,
): string | undefined {
  const parts: string[] = [];

  if (agentFilter) {
    parts.push(`agent = "${escapeFilterValue(agentFilter)}"`);
  }

  if (typeFilter && typeFilter.length > 0) {
    const unique = Array.from(new Set(typeFilter.filter(isMemoryType)));
    if (unique.length > 0) {
      parts.push(`(${unique.map(type => `type = \"${escapeFilterValue(type)}\"`).join(" OR ")})`);
    }
  }

  if (workstreamFilter && workstreamFilter.trim()) {
    parts.push(`workstream = "${escapeFilterValue(workstreamFilter.trim())}"`);
  }

  if (parts.length === 0) return undefined;
  return parts.join(" AND ");
}

function importance(type: MemoryType): number {
  switch (type) {
    case "summary": return 3;
    case "decision": return 2;
    case "discovery": return 1;
    case "message": return 0;
    default: return 0;
  }
}

function evictIfNeeded(store: MemoryStore): number {
  if (!store.collection) return 0;
  const maxEntries = Math.max(1, store.config.maxEntries);
  const docs = queryAll(store, ["agent", "type", "createdAtMs"]);
  if (docs.length <= maxEntries) return 0;

  const maxPerAgent = Math.max(1, Math.floor(maxEntries * MAX_AGENT_SHARE));
  const candidates = docs.map(doc => {
    const fields = doc.fields ?? {};
    const agent = typeof fields.agent === "string" ? fields.agent : "";
    const type = asMemoryType(fields.type);
    const createdAtMs = Number(fields.createdAtMs ?? 0) || 0;
    return {
      id: doc.id,
      agent,
      type,
      createdAtMs,
      importance: importance(type),
    };
  });

  const byAgent = new Map<string, number>();
  for (const c of candidates) {
    byAgent.set(c.agent, (byAgent.get(c.agent) ?? 0) + 1);
  }

  const deletions: string[] = [];
  let removeCount = docs.length - maxEntries;

  const sortCandidates = (list: typeof candidates) => list.sort((a, b) => {
    if (a.importance !== b.importance) return a.importance - b.importance;
    return a.createdAtMs - b.createdAtMs;
  });

  sortCandidates(candidates);

  while (removeCount > 0) {
    let index = candidates.findIndex(c => (byAgent.get(c.agent) ?? 0) > maxPerAgent);
    if (index === -1) {
      if (candidates.length === 0) break;
      index = 0;
    }

    const [picked] = candidates.splice(index, 1);
    if (!picked) break;
    deletions.push(picked.id);
    byAgent.set(picked.agent, Math.max(0, (byAgent.get(picked.agent) ?? 0) - 1));
    removeCount -= 1;
  }

  if (deletions.length === 0) return 0;

  try {
    store.collection.deleteSync(deletions);
    return deletions.length;
  } catch {
    return 0;
  }
}

function hasContentHash(store: MemoryStore, hash: string): boolean {
  if (!store.collection) return false;
  try {
    const found = store.collection.querySync({
      filter: `contentHash = "${escapeFilterValue(hash)}"`,
      topk: 1,
      outputFields: ["contentHash"],
    });
    return found.length > 0;
  } catch {
    return false;
  }
}

function initializeCollection(store: MemoryStore, runtime: Record<string, unknown>): void {
  const collectionPath = store.collectionPath;
  const collection = openCollection(runtime, collectionPath, store.config);
  validateCollectionShape(collection, store.config);
  validateMetadata(collectionPath, store.config);

  store.collection = collection;
  store.degraded = false;
  store.reason = undefined;

  const health = runHealthCheck(store);
  if (!health.ok) {
    throw new HealthcheckError(health.error ?? "unknown");
  }

  pruneExpired(store, store.config.ttlDays);
}

function attemptSelfHeal(
  store: MemoryStore,
  runtime: Record<string, unknown>,
  reason: string,
): { ok: boolean; backupPath?: string; error?: string } {
  closeMemory(store);

  let backupPath: string | null = null;
  try {
    backupPath = backupAndResetCollectionPath(store.projectDir, store.collectionPath, reason);
  } catch (error) {
    return {
      ok: false,
      error: `backup_failed:${isErrorWithMessage(error) ? error.message : "unknown"}`,
    };
  }

  try {
    initializeCollection(store, runtime);
    console.warn(`[pi-messenger][orchestrator] memory self-healed after '${reason}'${backupPath ? ` (backup: ${backupPath})` : ""}`);
    return {
      ok: true,
      ...(backupPath ? { backupPath } : {}),
    };
  } catch (error) {
    closeMemory(store);
    return {
      ok: false,
      ...(backupPath ? { backupPath } : {}),
      error: isErrorWithMessage(error) ? error.message : "reinit_failed",
    };
  }
}

export async function initMemory(projectDir: string, config: MemoryConfig): Promise<MemoryStore> {
  const store = createStore(projectDir, config);

  if (!config.enabled) {
    activeStore = store;
    return store;
  }

  const runtime = await getZvecRuntime();
  if (!runtime) {
    store.degraded = true;
    store.reason = "zvec_unavailable";
    activeStore = store;
    return store;
  }

  try {
    initializeCollection(store, runtime);
    activeStore = store;
    return store;
  } catch (error) {
    closeMemory(store);

    if (error instanceof SchemaMismatchError) {
      throw error;
    }

    if (isLikelyCorruptionError(error)) {
      const reason = error instanceof HealthcheckError
        ? `healthcheck_failed:${error.healthError}`
        : (error instanceof Error ? error.message : "memory_corruption_detected");

      const healed = attemptSelfHeal(store, runtime, reason);
      if (healed.ok) {
        store.degraded = false;
        store.reason = undefined;
        activeStore = store;
        return store;
      }

      store.degraded = true;
      store.reason = `self_heal_failed: ${healed.error ?? reason}`;
      activeStore = store;
      return store;
    }

    store.degraded = true;
    store.reason = error instanceof Error ? error.message : "memory_init_failed";
    activeStore = store;
    return store;
  }
}

export async function remember(
  store: MemoryStore,
  text: string,
  metadata: {
    agent: string;
    type: MemoryType;
    source: string;
    taskId?: string;
    workstream?: string;
    files?: string[];
  },
): Promise<{ ok: boolean; degraded?: boolean; error?: string }> {
  const trimmed = text.trim();
  if (!trimmed) {
    return { ok: false, error: "empty_text" };
  }

  if (!store.enabled || store.degraded || !store.collection) {
    return { ok: false, degraded: true, error: store.reason ?? "memory_unavailable" };
  }

  if (breakerOpen(store)) {
    return { ok: false, degraded: true, error: "embedding_circuit_breaker_open" };
  }

  const hash = contentHash(trimmed);
  if (hasContentHash(store, hash)) {
    return { ok: true };
  }

  const embedded = await embed(trimmed, {
    provider: store.config.embeddingProvider,
    model: store.config.embeddingModel,
    dimensions: store.config.dimensions,
    timeoutMs: store.config.embeddingTimeoutMs,
    taskType: "RETRIEVAL_DOCUMENT",
  });

  if (!embedded.ok || embedded.vector.length === 0) {
    markEmbeddingFailure(store, embedded.error ?? "embedding_failed");
    return { ok: false, degraded: true, error: embedded.error ?? "embedding_failed" };
  }

  if (embedded.vector.length !== store.config.dimensions) {
    markEmbeddingFailure(store, `embedding_dimensions_mismatch:${embedded.vector.length}`);
    return { ok: false, degraded: true, error: "embedding_dimensions_mismatch" };
  }

  markEmbeddingSuccess(store);

  const now = Date.now();
  const id = `${now}-${randomUUID().slice(0, 8)}`;

  try {
    const status = store.collection.insertSync({
      id,
      vectors: { [VECTOR_FIELD]: embedded.vector },
      fields: {
        agent: metadata.agent,
        type: metadata.type,
        source: metadata.source,
        timestamp: new Date(now).toISOString(),
        createdAtMs: now,
        taskId: metadata.taskId ?? "",
        workstream: metadata.workstream?.trim() ?? "",
        files: JSON.stringify(metadata.files ?? []),
        contentHash: hash,
        schemaVersion: SCHEMA_VERSION,
        embeddingModel: store.config.embeddingModel,
        embeddingDimensions: store.config.dimensions,
        text: trimmed,
      },
    }) as { ok?: boolean; message?: string };

    if (!status || status.ok !== true) {
      return { ok: false, degraded: true, error: status?.message ?? "insert_failed" };
    }

    evictIfNeeded(store);
    return { ok: true };
  } catch (error) {
    return { ok: false, degraded: true, error: error instanceof Error ? error.message : "insert_failed" };
  }
}

export async function recall(
  store: MemoryStore,
  query: string,
  options?: {
    topk?: number;
    minSimilarity?: number;
    maxTokens?: number;
    agentFilter?: string;
    typeFilter?: MemoryType[];
    workstreamFilter?: string;
  },
): Promise<{ results: MemoryEntry[]; degraded?: boolean }> {
  const text = query.trim();
  if (!text) {
    return { results: [] };
  }

  if (!store.enabled || store.degraded || !store.collection) {
    return { results: [], degraded: true };
  }

  if (breakerOpen(store)) {
    return { results: [], degraded: true };
  }

  const embedded = await embed(text, {
    provider: store.config.embeddingProvider,
    model: store.config.embeddingModel,
    dimensions: store.config.dimensions,
    timeoutMs: store.config.embeddingTimeoutMs,
    taskType: "RETRIEVAL_QUERY",
  });

  if (!embedded.ok || embedded.vector.length === 0) {
    markEmbeddingFailure(store, embedded.error ?? "embedding_failed");
    return { results: [], degraded: true };
  }

  if (embedded.vector.length !== store.config.dimensions) {
    markEmbeddingFailure(store, `embedding_dimensions_mismatch:${embedded.vector.length}`);
    return { results: [], degraded: true };
  }

  markEmbeddingSuccess(store);

  const topk = Math.max(1, options?.topk ?? store.config.autoInjectTopK);
  const minSimilarity = options?.minSimilarity ?? store.config.minSimilarity;
  const maxTokens = Math.max(1, options?.maxTokens ?? store.config.maxInjectionTokens);
  const filter = buildFilter(options?.agentFilter, options?.typeFilter, options?.workstreamFilter);

  try {
    const docs = store.collection.querySync({
      fieldName: VECTOR_FIELD,
      vector: embedded.vector,
      topk,
      ...(filter ? { filter } : {}),
      outputFields: [
        "agent",
        "type",
        "source",
        "timestamp",
        "createdAtMs",
        "taskId",
        "workstream",
        "files",
        "contentHash",
        "text",
      ],
    });

    const ranked: MemoryEntry[] = [];

    for (const doc of docs) {
      const fields = doc.fields ?? {};
      const similarity = distanceToSimilarity(doc.score);
      if (similarity < minSimilarity) continue;

      const createdAtMs = Number(fields.createdAtMs ?? 0) || 0;
      const entry: MemoryEntry = {
        id: doc.id,
        text: typeof fields.text === "string" ? fields.text : "",
        agent: typeof fields.agent === "string" ? fields.agent : "unknown",
        type: asMemoryType(fields.type),
        source: typeof fields.source === "string" ? fields.source : "unknown",
        timestamp: typeof fields.timestamp === "string" ? fields.timestamp : new Date(createdAtMs || Date.now()).toISOString(),
        createdAtMs,
        taskId: typeof fields.taskId === "string" && fields.taskId.length > 0 ? fields.taskId : undefined,
        workstream: typeof fields.workstream === "string" && fields.workstream.length > 0
          ? fields.workstream
          : undefined,
        files: parseFiles(fields.files),
        contentHash: typeof fields.contentHash === "string" ? fields.contentHash : "",
        similarity,
        relevance: similarity + recencyBonus(createdAtMs),
      };
      ranked.push(entry);
    }

    ranked.sort((a, b) => {
      if (b.relevance !== a.relevance) return b.relevance - a.relevance;
      return b.createdAtMs - a.createdAtMs;
    });

    const clipped: MemoryEntry[] = [];
    let usedTokens = 0;
    for (const entry of ranked) {
      const tokens = approxTokens(entry.text);
      if (usedTokens + tokens > maxTokens) {
        continue;
      }
      clipped.push(entry);
      usedTokens += tokens;
    }

    return { results: clipped };
  } catch {
    return { results: [], degraded: true };
  }
}

export function forgetAgent(store: MemoryStore, agentName: string): number {
  if (!store.collection || !agentName) return 0;
  try {
    const docs = store.collection.querySync({
      filter: `agent = "${escapeFilterValue(agentName)}"`,
      topk: Math.max(1, store.collection.stats.docCount),
      outputFields: ["agent"],
    });
    if (docs.length === 0) return 0;
    store.collection.deleteSync(docs.map(doc => doc.id));
    return docs.length;
  } catch {
    return 0;
  }
}

export function pruneExpired(store: MemoryStore, ttlDays: TtlConfig): number {
  if (!store.collection) return 0;

  const dayMs = 24 * 60 * 60 * 1000;
  const now = Date.now();
  const docs = queryAll(store, ["type", "createdAtMs"]);
  if (docs.length === 0) return 0;

  const toDelete: string[] = [];
  for (const doc of docs) {
    const fields = doc.fields ?? {};
    const type = asMemoryType(fields.type);
    const createdAtMs = Number(fields.createdAtMs ?? 0) || 0;
    const ttl = ttlDays[type];
    const expiresAt = createdAtMs + (Math.max(0, ttl) * dayMs);
    if (expiresAt <= now) {
      toDelete.push(doc.id);
    }
  }

  if (toDelete.length === 0) return 0;
  try {
    store.collection.deleteSync(toDelete);
    return toDelete.length;
  } catch {
    return 0;
  }
}

export function getMemoryStats(store: MemoryStore): MemoryStats {
  const stats = defaultStats(store);
  if (!store.collection) return stats;

  stats.docCount = Math.max(0, store.collection.stats?.docCount ?? 0);
  const docs = queryAll(store, ["type", "agent", "workstream"]);

  for (const doc of docs) {
    const fields = doc.fields ?? {};
    const type = asMemoryType(fields.type);
    const agent = typeof fields.agent === "string" && fields.agent.length > 0
      ? fields.agent
      : "unknown";
    const workstream = typeof fields.workstream === "string" && fields.workstream.length > 0
      ? fields.workstream
      : "(none)";

    stats.byType[type] += 1;
    stats.byAgent[agent] = (stats.byAgent[agent] ?? 0) + 1;
    stats.byWorkstream[workstream] = (stats.byWorkstream[workstream] ?? 0) + 1;
  }

  return stats;
}

export function resetMemory(projectDir: string): void {
  const targetPath = memoryDir(projectDir);

  if (activeStore && activeStore.collectionPath === targetPath) {
    closeMemory(activeStore);
  }

  try {
    fs.rmSync(targetPath, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

export function closeMemory(store?: MemoryStore | null): void {
  const target = store ?? activeStore;
  if (!target) return;

  if (target.collection) {
    try {
      target.collection.closeSync();
    } catch {
      // ignore
    }
    target.collection = null;
  }

  if (activeStore === target) {
    activeStore = null;
  }
}

export function getActiveMemoryStore(): MemoryStore | null {
  return activeStore;
}
