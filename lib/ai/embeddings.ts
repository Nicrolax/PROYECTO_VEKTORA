/**
 * VEKTORA · FASE 2 — Servicio de embeddings.
 *
 * Produce vectores con exactamente `AI_EMBEDDING_DIMENSIONS` (1536 por defecto) para que
 * encajen en `provider_profiles.embedding` y `project_tasks.embedding` de db/schema.sql.
 * Groq no expone embeddings, así que la única ruta es Google AI Studio; el fallback aquí
 * es de reintentos, no de proveedor, y se dice explícitamente en el error.
 */

import type { AiConfig } from './config';
import { getAiConfig } from './config';
import { describeEmbeddingModel } from './embedding-models';
import { AiError, AiExhaustedError, errorMessage, isAiError, toRunStatus } from './errors';
import { estimateCostUsd } from './pricing';
import { buildEmbeddingProvider } from './providers';
import { buildTelemetrySink, type TelemetrySink } from './telemetry';
import type {
  AiContext,
  EmbeddingProvider,
  EmbeddingTaskType,
  TokenUsage,
} from './types';

export interface EmbedTextsRequest {
  texts: string[];
  taskType?: EmbeddingTaskType;
  context?: AiContext;
  signal?: AbortSignal;
}

export interface EmbedTextsResponse {
  vectors: number[][];
  model: string;
  dimensions: number;
  usage: TokenUsage;
  costUsd: number;
  latencyMs: number;
  runId: string | null;
}

export interface EmbeddingServiceOptions {
  config?: AiConfig;
  provider?: EmbeddingProvider | null;
  telemetry?: TelemetrySink;
  sleep?: (ms: number) => Promise<void>;
}

const sleepMs = (ms: number): Promise<void> =>
  ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));

export class EmbeddingService {
  private readonly config: AiConfig;
  private readonly provider: EmbeddingProvider | null;
  private readonly telemetry: TelemetrySink;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: EmbeddingServiceOptions = {}) {
    this.config = options.config ?? getAiConfig();
    this.provider =
      options.provider !== undefined ? options.provider : buildEmbeddingProvider(this.config);
    this.telemetry = options.telemetry ?? buildTelemetrySink(this.config);
    this.sleep = options.sleep ?? sleepMs;
  }

  get dimensions(): number {
    return this.config.AI_EMBEDDING_DIMENSIONS;
  }

  /** Tipo de tarea por defecto (`AI_EMBEDDING_TASK_TYPE`). */
  get defaultTaskType(): EmbeddingTaskType {
    return this.config.AI_EMBEDDING_TASK_TYPE;
  }

  /** Descripción legible del modelo activo, para diagnóstico. */
  describeModel(): string {
    return describeEmbeddingModel(
      this.config.AI_EMBEDDING_MODEL,
      this.config.AI_EMBEDDING_DIMENSIONS,
    );
  }

  isAvailable(): boolean {
    return this.provider !== null;
  }

  /** Embeddea un lote respetando `AI_EMBED_CONCURRENCY` y reintentando lo reintentable. */
  async embedTexts(request: EmbedTextsRequest): Promise<EmbedTextsResponse> {
    const provider = this.provider;
    if (provider === null) {
      throw new AiError({
        code: 'not_configured',
        message:
          'VEKTORA/AI: los embeddings requieren GOOGLE_AI_API_KEY (Groq no expone embeddings).',
      });
    }
    if (request.texts.length === 0) {
      throw new AiError({
        code: 'bad_request',
        message: 'VEKTORA/AI: embedTexts recibió un lote vacío',
      });
    }

    const startedAt = Date.now();
    const runId = await this.telemetry.start({
      operation: 'embedding',
      provider: provider.id,
      model: provider.model,
      attempt: 1,
      fellBackFrom: null,
      parentRunId: null,
      context: request.context,
      requestPayload: {
        count: request.texts.length,
        taskType: request.taskType ?? this.defaultTaskType,
        model: this.config.AI_EMBEDDING_MODEL,
        dimensions: this.dimensions,
      },
    });

    try {
      const taskType = request.taskType ?? this.defaultTaskType;
      const batches = chunk(request.texts, this.config.AI_EMBED_CONCURRENCY);
      const vectors: number[][] = [];
      let promptTokens = 0;

      for (const batch of batches) {
        const results = await Promise.all(
          batch.map((text) =>
            this.embedOneWithRetry(provider, text, taskType, request.signal),
          ),
        );
        for (const result of results) {
          vectors.push(result.vector);
          promptTokens += result.promptTokens;
        }
      }

      const usage: TokenUsage = { promptTokens, totalTokens: promptTokens };
      const latencyMs = Date.now() - startedAt;
      const costUsd = estimateCostUsd(provider.model, promptTokens, 0);

      await this.telemetry.finish(runId, {
        status: 'success',
        usage,
        latencyMs,
        costUsd,
        responsePayload: { vectors: vectors.length, dimensions: this.dimensions },
      });

      return {
        vectors,
        model: provider.model,
        dimensions: this.dimensions,
        usage,
        costUsd,
        latencyMs,
        runId,
      };
    } catch (error) {
      await this.telemetry.finish(runId, {
        status: toRunStatus(error),
        latencyMs: Date.now() - startedAt,
        errorMessage: errorMessage(error),
      });
      throw error;
    }
  }

  /** Atajo para un solo texto. */
  async embedText(
    text: string,
    taskType?: EmbeddingTaskType,
    context?: AiContext,
  ): Promise<number[]> {
    const response = await this.embedTexts({
      texts: [text],
      taskType: taskType ?? this.defaultTaskType,
      ...(context === undefined ? {} : { context }),
    });
    const vector = response.vectors[0];
    if (vector === undefined) {
      throw new AiError({
        code: 'invalid_output',
        message: 'VEKTORA/AI: el proveedor no devolvió ningún vector',
      });
    }
    return vector;
  }

  private async embedOneWithRetry(
    provider: EmbeddingProvider,
    text: string,
    taskType: EmbeddingTaskType | undefined,
    signal: AbortSignal | undefined,
  ): Promise<{ vector: number[]; promptTokens: number }> {
    const maxAttempts = this.config.AI_MAX_ATTEMPTS_PER_PROVIDER;
    const failures = [];

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const result = await provider.embed({
          input: [text],
          dimensions: this.dimensions,
          ...(taskType === undefined ? {} : { taskType }),
          ...(signal === undefined ? {} : { signal }),
        });
        const vector = result.vectors[0];
        if (vector === undefined) {
          throw new AiError({
            code: 'invalid_output',
            message: 'VEKTORA/AI: respuesta de embedding vacía',
            provider: provider.id,
            model: provider.model,
          });
        }
        return { vector, promptTokens: result.usage.promptTokens ?? 0 };
      } catch (error) {
        const aiError = isAiError(error)
          ? error
          : new AiError({ code: 'network', message: errorMessage(error) });
        failures.push({
          provider: provider.id,
          model: provider.model,
          attempt,
          code: aiError.code,
          message: aiError.message,
        });
        if (!aiError.retryable || attempt === maxAttempts) {
          if (attempt === maxAttempts && aiError.retryable) throw new AiExhaustedError(failures);
          throw aiError;
        }
        const delay = Math.min(
          aiError.retryAfterMs ?? this.config.AI_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1),
          this.config.AI_RETRY_MAX_DELAY_MS,
        );
        await this.sleep(delay);
      }
    }

    throw new AiExhaustedError(failures);
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Serializa un vector al literal que espera pgvector.
 * Se valida la dimensión aquí para que un vector mal formado falle en la aplicación y no
 * como error de tipo de PostgreSQL a mitad de un insert por lotes.
 */
export function toPgVector(vector: number[], expectedDimensions?: number): string {
  if (expectedDimensions !== undefined && vector.length !== expectedDimensions) {
    throw new AiError({
      code: 'invalid_output',
      message: `VEKTORA/AI: se esperaban ${expectedDimensions} dimensiones y llegaron ${vector.length}`,
    });
  }
  for (const value of vector) {
    if (!Number.isFinite(value)) {
      throw new AiError({
        code: 'invalid_output',
        message: 'VEKTORA/AI: el vector contiene valores no finitos',
      });
    }
  }
  return `[${vector.join(',')}]`;
}

/** Similitud coseno; útil para tests y para el ranking determinista de la FASE 4. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new AiError({
      code: 'bad_request',
      message: `VEKTORA/AI: dimensiones incompatibles (${a.length} vs ${b.length})`,
    });
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dot / denominator;
}

let singleton: EmbeddingService | null = null;

export function getEmbeddingService(): EmbeddingService {
  if (singleton === null) singleton = new EmbeddingService();
  return singleton;
}

export function resetEmbeddingService(): void {
  singleton = null;
}
