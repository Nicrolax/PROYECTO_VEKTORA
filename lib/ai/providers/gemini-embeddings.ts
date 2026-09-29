/**
 * VEKTORA · FASE 2 — Adaptador de embeddings de Google AI Studio (free tier).
 *
 * `POST {base}/models/{model}:embedContent?key=...`
 *
 * Va en su propia clase, separada de `GeminiProvider`: el modelo de chat y el de embedding
 * son distintos (`gemini-2.5-flash` vs `gemini-embedding-001`) y compartir la propiedad
 * `model` hacía que la telemetría y el cálculo de coste registraran el modelo equivocado.
 *
 * Sobre `outputDimensionality`: recorta el vector mediante Matryoshka Representation
 * Learning, NUNCA lo amplía. `gemini-embedding-001` es nativo de 3072 y Google recomienda
 * 3072 / 1536 / 768; 1536 es el tamaño que usa `vector(1536)` en db/schema.sql. Al recortar
 * el vector pierde la norma unitaria, así que se renormaliza (L2) para que el operador
 * `<=>` de pgvector siga siendo distancia coseno.
 *
 * Los errores de dimensión son NO reintentables a propósito: repetir la misma petición
 * devuelve el mismo tamaño. Es un desajuste de configuración, no un fallo transitorio.
 */

import type { AiConfig } from '../config';
import { AiError } from '../errors';
import { postJson } from './http';
import type {
  AiProviderId,
  EmbedRequest,
  EmbedResult,
  EmbeddingProvider,
} from '../types';

interface GeminiEmbedResponse {
  embedding?: { values?: number[] };
}

export class GeminiEmbeddingProvider implements EmbeddingProvider {
  readonly id: AiProviderId = 'google';
  readonly model: string;
  readonly dimensions: number;

  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(config: AiConfig) {
    this.apiKey = config.GOOGLE_AI_API_KEY;
    this.baseUrl = config.GOOGLE_AI_BASE_URL.replace(/\/+$/, '');
    this.model = config.AI_EMBEDDING_MODEL;
    this.dimensions = config.AI_EMBEDDING_DIMENSIONS;
    this.timeoutMs = config.AI_REQUEST_TIMEOUT_MS;
  }

  isConfigured(): boolean {
    return typeof this.apiKey === 'string' && this.apiKey.length > 0;
  }

  async embed(request: EmbedRequest): Promise<EmbedResult> {
    if (!this.isConfigured()) {
      throw new AiError({
        code: 'not_configured',
        message: 'VEKTORA/AI: GOOGLE_AI_API_KEY no está definida',
        provider: this.id,
        model: this.model,
      });
    }

    const dimensions = request.dimensions ?? this.dimensions;
    const vectors: number[][] = [];
    let promptTokens = 0;

    for (const input of request.input) {
      if (input.trim() === '') {
        throw new AiError({
          code: 'bad_request',
          message: 'VEKTORA/AI: no se puede embeddear una cadena vacía',
          provider: this.id,
          model: this.model,
        });
      }

      const body: Record<string, unknown> = {
        model: `models/${this.model}`,
        content: { parts: [{ text: input }] },
        outputDimensionality: dimensions,
      };
      if (request.taskType !== undefined) body['taskType'] = request.taskType;

      const response = await postJson({
        url: `${this.baseUrl}/models/${encodeURIComponent(this.model)}:embedContent`,
        body,
        headers: { 'x-goog-api-key': this.apiKey ?? '' },
        timeoutMs: this.timeoutMs,
        provider: this.id,
        model: this.model,
        signal: request.signal,
      });

      const payload = (response.json ?? {}) as GeminiEmbedResponse;
      const values = payload.embedding?.values;

      if (!Array.isArray(values) || values.length === 0) {
        throw new AiError({
          code: 'invalid_output',
          message: 'VEKTORA/AI: respuesta de embedding sin valores',
          provider: this.id,
          model: this.model,
          retryable: false,
          details: payload,
        });
      }
      if (values.length !== dimensions) {
        throw new AiError({
          code: 'invalid_output',
          message:
            `VEKTORA/AI: el modelo "${this.model}" devolvió ${values.length} dimensiones y se ` +
            `esperaban ${dimensions} (vector(${dimensions}) en db/schema.sql). ` +
            'outputDimensionality solo recorta: revisa AI_EMBEDDING_MODEL / ' +
            'AI_EMBEDDING_DIMENSIONS.',
          provider: this.id,
          model: this.model,
          retryable: false,
        });
      }

      vectors.push(normalizeL2(values));
      promptTokens += estimateTokens(input);
    }

    return {
      vectors,
      model: this.model,
      dimensions,
      usage: { promptTokens, totalTokens: promptTokens },
    };
  }
}

/** Normalización L2. Un vector nulo se rechaza: rompería la distancia coseno. */
export function normalizeL2(values: number[]): number[] {
  let sum = 0;
  for (const value of values) sum += value * value;
  const norm = Math.sqrt(sum);
  if (!Number.isFinite(norm) || norm === 0) {
    throw new AiError({
      code: 'invalid_output',
      message: 'VEKTORA/AI: embedding con norma cero; no es utilizable con distancia coseno',
      provider: 'google',
      retryable: false,
    });
  }
  return values.map((value) => value / norm);
}

/** Aproximación de tokens: `embedContent` no devuelve usageMetadata. */
function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}
