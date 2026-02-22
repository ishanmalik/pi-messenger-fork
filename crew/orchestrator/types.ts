import type { ZVecCollection } from "@zvec/zvec";

export type SpawnBackend = "tmux" | "headless";

export type SpawnedAgentStatus =
  | "spawning"
  | "joined"
  | "idle"
  | "assigned"
  | "done"
  | "dead";

export interface SpawnedAgent {
  name: string;
  pid: number;
  sessionId: string;
  tmuxPaneId: string | null;
  tmuxWindowId: string | null;
  model: string;
  thinking?: string;
  status: SpawnedAgentStatus;
  spawnedAt: number;
  spawnedBy: string;
  assignedTask: string | null;
  lastActivityAt: number;
  backend: SpawnBackend;
}

export type HistoryEventType = "spawn" | "kill" | "assign" | "done" | "reap";

export interface HistoryEvent {
  event: HistoryEventType;
  agent: string;
  timestamp: string;
  details?: Record<string, unknown>;
}

export type MemoryType = "summary" | "message" | "decision" | "discovery";

export interface TtlConfig {
  message: number;
  discovery: number;
  summary: number;
  decision: number;
}

export interface MemoryConfig {
  enabled: boolean;
  embeddingModel: string;
  embeddingProvider: string;
  dimensions: number;
  maxEntries: number;
  autoInjectTopK: number;
  minSimilarity: number;
  maxInjectionTokens: number;
  embeddingTimeoutMs: number;
  ttlDays: TtlConfig;
}

export interface MemoryEntry {
  id: string;
  text: string;
  agent: string;
  type: MemoryType;
  source: string;
  timestamp: string;
  createdAtMs: number;
  taskId?: string;
  files?: string[];
  contentHash: string;
  similarity: number;
  relevance: number;
}

export interface MemoryStats {
  enabled: boolean;
  degraded: boolean;
  reason?: string;
  docCount: number;
  byType: Record<MemoryType, number>;
  byAgent: Record<string, number>;
  circuitBreakerOpen: boolean;
  circuitBreakerOpenUntil: number | null;
  circuitBreakerSecondsRemaining: number;
  consecutiveEmbeddingFailures: number;
  dimensions: number;
  embeddingModel: string;
  collectionPath: string;
}

export interface MemoryStore {
  enabled: boolean;
  degraded: boolean;
  reason?: string;
  projectDir: string;
  collectionPath: string;
  config: MemoryConfig;
  collection: ZVecCollection | null;
  consecutiveEmbeddingFailures: number;
  breakerOpenUntil: number;
  lastError?: string;
}
