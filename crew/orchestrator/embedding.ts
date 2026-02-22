export interface EmbeddingRequest {
  provider: string;
  model: string;
  dimensions: number;
  timeoutMs: number;
}

export interface EmbeddingResult {
  vector: number[];
  ok: boolean;
  error?: string;
}

function normalize(vector: number[]): number[] {
  let sumSquares = 0;
  for (const v of vector) sumSquares += v * v;
  if (sumSquares <= 0) return vector;
  const norm = Math.sqrt(sumSquares);
  return vector.map(v => v / norm);
}

function getProviderEndpoint(provider: string): { endpoint: string; apiKey: string | undefined } | null {
  const key = provider.toLowerCase();
  if (key === "openai") {
    return {
      endpoint: process.env.OPENAI_API_BASE?.trim() || "https://api.openai.com/v1/embeddings",
      apiKey: process.env.OPENAI_API_KEY,
    };
  }
  return null;
}

function parseEmbedding(json: unknown): number[] | null {
  if (!json || typeof json !== "object") return null;
  const data = (json as { data?: unknown }).data;
  if (!Array.isArray(data) || data.length === 0) return null;
  const first = data[0] as { embedding?: unknown };
  if (!first || !Array.isArray(first.embedding)) return null;

  const vector: number[] = [];
  for (const item of first.embedding) {
    if (typeof item !== "number" || !Number.isFinite(item)) {
      return null;
    }
    vector.push(item);
  }
  return vector;
}

export async function embed(text: string, config: EmbeddingRequest): Promise<EmbeddingResult> {
  const resolved = getProviderEndpoint(config.provider);
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
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${resolved.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        input: text,
        dimensions: config.dimensions,
      }),
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
    const vector = parseEmbedding(data);
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
