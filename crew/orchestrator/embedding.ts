import * as fs from "node:fs";
import * as path from "node:path";

export type EmbeddingTaskType =
  | "RETRIEVAL_DOCUMENT"
  | "RETRIEVAL_QUERY"
  | "SEMANTIC_SIMILARITY"
  | "QUESTION_ANSWERING"
  | "FACT_VERIFICATION"
  | "CLASSIFICATION"
  | "CLUSTERING"
  | "CODE_RETRIEVAL_QUERY";

export interface EmbeddingRequest {
  provider: string;
  model: string;
  dimensions: number;
  timeoutMs: number;
  taskType?: EmbeddingTaskType;
}

export interface EmbeddingResult {
  vector: number[];
  ok: boolean;
  error?: string;
}

let localSecretsCache: Record<string, string> | null | undefined;
const insecurePermissionWarned = new Set<string>();

function warnIfPermissionsTooOpen(filePath: string): void {
  if (process.platform === "win32") return;
  if (insecurePermissionWarned.has(filePath)) return;

  try {
    const stats = fs.statSync(filePath);
    const mode = stats.mode & 0o777;
    if ((mode & 0o077) !== 0) {
      insecurePermissionWarned.add(filePath);
      console.warn(`[pi-messenger][orchestrator] warning: secret file ${filePath} permissions are broad (${mode.toString(8)}). Recommend chmod 600.`);
    }
  } catch {
    // best effort
  }
}

function parseEnvFile(filePath: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!fs.existsSync(filePath)) return out;

  warnIfPermissionsTooOpen(filePath);

  let text = "";
  try {
    text = fs.readFileSync(filePath, "utf-8");
  } catch {
    return out;
  }

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;

    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/^['\"]|['\"]$/g, "");
    if (!key) continue;
    out[key] = value;
  }

  return out;
}

function loadLocalSecrets(): Record<string, string> {
  if (localSecretsCache !== undefined) {
    return localSecretsCache ?? {};
  }

  const cwd = process.cwd();
  const merged: Record<string, string> = {
    ...parseEnvFile(path.join(cwd, ".env.local")),
    ...parseEnvFile(path.join(cwd, "secrets", "local.env")),
  };

  localSecretsCache = merged;
  return merged;
}

function getSecret(keys: string[]): string | undefined {
  for (const key of keys) {
    const envVal = process.env[key];
    if (typeof envVal === "string" && envVal.trim()) {
      return envVal.trim();
    }
  }

  const localSecrets = loadLocalSecrets();
  for (const key of keys) {
    const fileVal = localSecrets[key];
    if (typeof fileVal === "string" && fileVal.trim()) {
      return fileVal.trim();
    }
  }

  return undefined;
}

function normalize(vector: number[]): number[] {
  let sumSquares = 0;
  for (const v of vector) sumSquares += v * v;
  if (sumSquares <= 0) return vector;
  const norm = Math.sqrt(sumSquares);
  return vector.map(v => v / norm);
}

function toNumberArray(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const out: number[] = [];
  for (const item of value) {
    if (typeof item !== "number" || !Number.isFinite(item)) return null;
    out.push(item);
  }
  return out;
}

function parseOpenAIEmbedding(json: unknown): number[] | null {
  if (!json || typeof json !== "object") return null;
  const data = (json as { data?: unknown }).data;
  if (!Array.isArray(data) || data.length === 0) return null;
  const first = data[0] as { embedding?: unknown };
  return toNumberArray(first?.embedding);
}

function parseGeminiEmbedding(json: unknown): number[] | null {
  if (!json || typeof json !== "object") return null;

  const single = (json as { embedding?: { values?: unknown } }).embedding;
  const singleValues = toNumberArray(single?.values);
  if (singleValues) return singleValues;

  const batch = (json as { embeddings?: Array<{ values?: unknown }> }).embeddings;
  if (Array.isArray(batch) && batch.length > 0) {
    const values = toNumberArray(batch[0]?.values);
    if (values) return values;
  }

  return null;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
}

function resolveOpenAIConfig(config: EmbeddingRequest): {
  endpoint: string;
  apiKey: string | undefined;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  parser: (json: unknown) => number[] | null;
} {
  const apiKey = getSecret(["OPENAI_API_KEY"]);

  return {
    endpoint: process.env.OPENAI_API_BASE?.trim() || "https://api.openai.com/v1/embeddings",
    apiKey,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey ?? ""}`,
    },
    body: {
      model: config.model,
      input: textToInput(config),
      dimensions: config.dimensions,
    },
    parser: parseOpenAIEmbedding,
  };
}

function resolveGeminiConfig(config: EmbeddingRequest): {
  endpoint: string;
  apiKey: string | undefined;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  parser: (json: unknown) => number[] | null;
} {
  const apiKey = getSecret([
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "GOOGLE_GENERATIVE_AI_API_KEY",
  ]);

  const base = normalizeBaseUrl(
    process.env.GEMINI_API_BASE?.trim()
      || process.env.GOOGLE_API_BASE?.trim()
      || "https://generativelanguage.googleapis.com/v1beta",
  );

  const modelResource = config.model.startsWith("models/")
    ? config.model
    : `models/${config.model}`;

  const body: Record<string, unknown> = {
    model: modelResource,
    content: {
      parts: [{ text: textToInput(config) }],
    },
    outputDimensionality: config.dimensions,
  };

  if (config.taskType) {
    body.taskType = config.taskType;
  }

  return {
    endpoint: `${base}/${modelResource}:embedContent`,
    apiKey,
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey ?? "",
    },
    body,
    parser: parseGeminiEmbedding,
  };
}

function textToInput(config: EmbeddingRequest): string {
  return (config as EmbeddingRequest & { text?: string }).text ?? "";
}

function buildProviderRequest(config: EmbeddingRequest, text: string): {
  endpoint: string;
  apiKey: string | undefined;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  parser: (json: unknown) => number[] | null;
} | null {
  const extended = { ...config, text } as EmbeddingRequest & { text: string };
  const provider = config.provider.toLowerCase();

  if (provider === "openai") {
    return resolveOpenAIConfig(extended);
  }

  if (provider === "google" || provider === "gemini") {
    return resolveGeminiConfig(extended);
  }

  return null;
}

export async function embed(text: string, config: EmbeddingRequest): Promise<EmbeddingResult> {
  const resolved = buildProviderRequest(config, text);
  if (!resolved) {
    return {
      vector: [],
      ok: false,
      error: `Unsupported embedding provider: ${config.provider}`,
    };
  }

  if (!resolved.apiKey) {
    return {
      vector: [],
      ok: false,
      error: `${config.provider.toUpperCase()} API key missing`,
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1, config.timeoutMs));

  try {
    const response = await fetch(resolved.endpoint, {
      method: "POST",
      headers: resolved.headers,
      body: JSON.stringify(resolved.body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      return {
        vector: [],
        ok: false,
        error: `Embedding request failed (${response.status}): ${body || response.statusText}`,
      };
    }

    const data = await response.json().catch(() => null);
    const vector = resolved.parser(data);
    if (!vector || vector.length === 0) {
      return {
        vector: [],
        ok: false,
        error: "Embedding response missing vector data",
      };
    }

    return {
      vector: normalize(vector),
      ok: true,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    return {
      vector: [],
      ok: false,
      error: message,
    };
  } finally {
    clearTimeout(timeout);
  }
}
