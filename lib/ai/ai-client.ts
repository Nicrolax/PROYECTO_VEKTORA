/**
 * VEKTORA · FASE 2 — Orquestador de IA.
 *
 * Responsabilidades, en este orden:
 *   1. Cadena de proveedores con fallback automático (Groq Llama 3.3 70B -> Gemini 2.5 Flash).
 *   2. Reintentos con backoff exponencial + jitter, respetando `Retry-After`.
 *   3. Extracción de JSON tolerante a la verborrea de los modelos abiertos.
 *   4. Validación con Zod estricto y BUCLE DE AUTO-REPARACIÓN: los errores de validación
 *      se devuelven al modelo como instrucción de corrección.
 *   5. Telemetría de cada intento en `ai_runs`, encadenada por `parent_run_id` y con
 *      `fell_back_from` cuando el turno pasó a otro proveedor.
 *
 * Nada de esto requiere intervención humana: es el requisito de sistema 100% autónomo.
 */

import type { z } from 'zod';
import type { AiConfig } from './config';
import { getAiConfig } from './config';
import {
  AiError,
  AiExhaustedError,
  errorMessage,
  isAiError,
  toRunStatus,
  type AiAttemptFailure,
  type FlatZodIssue,
} from './errors';
import { extractJson } from './json';
import { estimateCostUsd } from './pricing';
import { buildProviderChain } from './providers';
import { flattenZodIssues, renderRepairInstruction, toJsonSchema } from './schema';
import { buildTelemetrySink, type TelemetrySink } from './telemetry';
import type {
  AiContext,
  AiOperation,
  AiProviderId,
  ChatMessage,
  GenerateResult,
  JsonSchemaObject,
  LlmProvider,
  TokenUsage,
} from './types';

export interface AiClientOptions {
  config?: AiConfig;
  providers?: LlmProvider[];
  telemetry?: TelemetrySink;
  /** Inyectable para pruebas deterministas del backoff. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface StructuredRequest<T> {
  operation: AiOperation;
  schema: z.ZodType<T>;
  /** Nombre lógico del esquema; aparece en la telemetría. */
  schemaName?: string;
  system?: string;
  prompt?: string;
  /** Alternativa a `system`/`prompt` cuando hace falta historial completo. */
  messages?: ChatMessage[];
  context?: AiContext;
  temperature?: number;
  maxOutputTokens?: number;
  signal?: AbortSignal;
}

export interface TextRequest {
  operation: AiOperation;
  system?: string;
  prompt?: string;
  messages?: ChatMessage[];
  context?: AiContext;
  temperature?: number;
  maxOutputTokens?: number;
  signal?: AbortSignal;
}

export interface AiResponseMeta {
  provider: AiProviderId;
  model: string;
  /** Fila de `ai_runs` que resolvió la operación. */
  runId: string | null;
  /** Intentos de red totales (todos los proveedores, incluidas reparaciones). */
  attempts: number;
  repairs: number;
  fellBackFrom: AiProviderId | null;
  usage: TokenUsage;
  costUsd: number;
  latencyMs: number;
  schemaDegraded: boolean;
}

export interface StructuredResponse<T> extends AiResponseMeta {
  data: T;
}

export interface TextResponse extends AiResponseMeta {
  text: string;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(
        new AiError({
          code: 'timeout',
          message: 'VEKTORA/AI: espera de reintento cancelada',
        }),
      );
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

function buildMessages(request: {
  system?: string | undefined;
  prompt?: string | undefined;
  messages?: ChatMessage[] | undefined;
}): ChatMessage[] {
  if (request.messages !== undefined && request.messages.length > 0) {
    return request.messages;
  }
  const messages: ChatMessage[] = [];
  if (request.system !== undefined && request.system.trim() !== '') {
    messages.push({ role: 'system', content: request.system });
  }
  if (request.prompt !== undefined && request.prompt.trim() !== '') {
    messages.push({ role: 'user', content: request.prompt });
  }
  if (messages.length === 0) {
    throw new AiError({
      code: 'bad_request',
      message: 'VEKTORA/AI: la petición no contiene ni prompt ni messages',
    });
  }
  return messages;
}

interface AttemptRecord {
  result: GenerateResult;
  runId: string | null;
  latencyMs: number;
  costUsd: number;
}

export class AiClient {
  private readonly config: AiConfig;
  private readonly providers: LlmProvider[];
  private readonly telemetry: TelemetrySink;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(options: AiClientOptions = {}) {
    this.config = options.config ?? getAiConfig();
    this.providers = options.providers ?? buildProviderChain(this.config);
    this.telemetry = options.telemetry ?? buildTelemetrySink(this.config);
    this.sleep = options.sleep ?? defaultSleep;
  }

  /** Proveedores efectivamente disponibles, en orden de preferencia. */
  providerChain(): AiProviderId[] {
    return this.providers.map((provider) => provider.id);
  }

  /** Backoff exponencial con jitter completo, acotado por `AI_RETRY_MAX_DELAY_MS`. */
  private backoffMs(attempt: number, retryAfterMs?: number): number {
    if (retryAfterMs !== undefined) {
      return Math.min(retryAfterMs, this.config.AI_RETRY_MAX_DELAY_MS);
    }
    const exponential = this.config.AI_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
    const capped = Math.min(exponential, this.config.AI_RETRY_MAX_DELAY_MS);
    return Math.round(capped * (0.5 + Math.random() * 0.5));
  }

  /** Un intento de red con su fila de telemetría. Cierra la fila pase lo que pase. */
  private async runOnce(params: {
    provider: LlmProvider;
    operation: AiOperation;
    attempt: number;
    fellBackFrom: AiProviderId | null;
    parentRunId: string | null;
    messages: ChatMessage[];
    jsonSchema?: JsonSchemaObject | undefined;
    schemaName?: string | undefined;
    context?: AiContext | undefined;
    temperature: number;
    maxOutputTokens: number;
    signal?: AbortSignal | undefined;
  }): Promise<AttemptRecord> {
    const startedAt = Date.now();

    const runId = await this.telemetry.start({
      operation: params.operation,
      provider: params.provider.id,
      model: params.provider.model,
      attempt: params.attempt,
      fellBackFrom: params.fellBackFrom,
      parentRunId: params.parentRunId,
      context: params.context,
      requestPayload: {
        messages: params.messages,
        temperature: params.temperature,
        maxOutputTokens: params.maxOutputTokens,
        schemaName: params.schemaName ?? null,
        jsonSchema: params.jsonSchema ?? null,
      },
    });

    try {
      const result = await params.provider.generate({
        messages: params.messages,
        temperature: params.temperature,
        maxOutputTokens: params.maxOutputTokens,
        json: params.jsonSchema !== undefined,
        ...(params.jsonSchema === undefined ? {} : { jsonSchema: params.jsonSchema }),
        ...(params.schemaName === undefined ? {} : { jsonSchemaName: params.schemaName }),
        signal: params.signal,
      });

      const latencyMs = Date.now() - startedAt;
      const costUsd = estimateCostUsd(
        result.model,
        result.usage.promptTokens ?? 0,
        result.usage.completionTokens ?? 0,
      );
      return { result, runId, latencyMs, costUsd };
    } catch (error) {
      const latencyMs = Date.now() - startedAt;
      await this.telemetry.finish(runId, {
        status: toRunStatus(error),
        latencyMs,
        errorMessage: errorMessage(error),
      });
      throw error;
    }
  }

  /** Parsea y valida. Devuelve los issues en vez de lanzar, para el bucle de reparación. */
  private validate<T>(
    schema: z.ZodType<T>,
    text: string,
    provider: LlmProvider,
  ): { ok: true; data: T } | { ok: false; issues: FlatZodIssue[]; code: 'invalid_json' | 'invalid_output' } {
    let parsed: unknown;
    try {
      parsed = extractJson(text, { provider: provider.id, model: provider.model });
    } catch (error) {
      const message = errorMessage(error);
      return {
        ok: false,
        code: 'invalid_json',
        issues: [{ path: '(raíz)', code: 'invalid_json', message }],
      };
    }

    const result = schema.safeParse(parsed);
    if (result.success) return { ok: true, data: result.data };
    return { ok: false, code: 'invalid_output', issues: flattenZodIssues(result.error.issues) };
  }

  /**
   * Genera una respuesta validada contra un esquema Zod.
   * Recorre la cadena de proveedores y, ante salida inválida, intenta auto-repararla con
   * el mismo proveedor antes de ceder el turno al siguiente.
   */
  async generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResponse<T>> {
    if (this.providers.length === 0) throw new AiExhaustedError([]);

    const jsonSchema = toJsonSchema(request.schema);
    const baseMessages = buildMessages(request);
    const temperature = request.temperature ?? this.config.AI_TEMPERATURE;
    const maxOutputTokens = request.maxOutputTokens ?? this.config.AI_MAX_OUTPUT_TOKENS;

    const failures: AiAttemptFailure[] = [];
    let attempts = 0;
    let repairs = 0;
    let rootRunId: string | null = null;

    for (let providerIndex = 0; providerIndex < this.providers.length; providerIndex += 1) {
      const provider = this.providers[providerIndex];
      if (provider === undefined) continue;
      const previous = providerIndex > 0 ? this.providers[providerIndex - 1] : undefined;
      const fellBackFrom = previous?.id ?? null;

      for (let attempt = 1; attempt <= this.config.AI_MAX_ATTEMPTS_PER_PROVIDER; attempt += 1) {
        attempts += 1;

        let record: AttemptRecord;
        try {
          record = await this.runOnce({
            provider,
            operation: request.operation,
            attempt,
            fellBackFrom,
            parentRunId: rootRunId,
            messages: baseMessages,
            jsonSchema,
            schemaName: request.schemaName,
            context: request.context,
            temperature,
            maxOutputTokens,
            signal: request.signal,
          });
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
          if (aiError.code === 'not_configured') break;
          const canRetry =
            aiError.retryable && attempt < this.config.AI_MAX_ATTEMPTS_PER_PROVIDER;
          if (!canRetry) break;
          await this.sleep(this.backoffMs(attempt, aiError.retryAfterMs), request.signal);
          continue;
        }

        if (rootRunId === null) rootRunId = record.runId;

        const validation = this.validate(request.schema, record.result.text, provider);
        if (validation.ok) {
          await this.telemetry.finish(record.runId, {
            status: 'success',
            usage: record.result.usage,
            latencyMs: record.latencyMs,
            costUsd: record.costUsd,
            responsePayload: record.result.raw,
          });
          return {
            data: validation.data,
            provider: provider.id,
            model: record.result.model,
            runId: record.runId,
            attempts,
            repairs,
            fellBackFrom,
            usage: record.result.usage,
            costUsd: record.costUsd,
            latencyMs: record.latencyMs,
            schemaDegraded: record.result.schemaDegraded === true,
          };
        }

        // Salida inválida: se cierra la fila como invalid_output con los issues de Zod.
        await this.telemetry.finish(record.runId, {
          status: 'invalid_output',
          usage: record.result.usage,
          latencyMs: record.latencyMs,
          costUsd: record.costUsd,
          responsePayload: record.result.raw,
          zodErrors: validation.issues,
        });
        failures.push({
          provider: provider.id,
          model: provider.model,
          attempt,
          code: validation.code,
          message: validation.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; '),
        });

        // --- BUCLE DE AUTO-REPARACIÓN ---
        const repaired = await this.repair({
          provider,
          baseMessages,
          jsonSchema,
          schema: request.schema,
          schemaName: request.schemaName,
          context: request.context,
          temperature,
          maxOutputTokens,
          signal: request.signal,
          parentRunId: record.runId,
          fellBackFrom,
          previousText: record.result.text,
          issues: validation.issues,
          failures,
        });

        attempts += repaired.attempts;
        repairs += repaired.attempts;

        if (repaired.response !== null) {
          return { ...repaired.response, attempts, repairs };
        }

        if (attempt >= this.config.AI_MAX_ATTEMPTS_PER_PROVIDER) break;
        await this.sleep(this.backoffMs(attempt), request.signal);
      }
    }

    throw new AiExhaustedError(failures);
  }

  private async repair<T>(params: {
    provider: LlmProvider;
    baseMessages: ChatMessage[];
    jsonSchema: JsonSchemaObject;
    schema: z.ZodType<T>;
    schemaName?: string | undefined;
    context?: AiContext | undefined;
    temperature: number;
    maxOutputTokens: number;
    signal?: AbortSignal | undefined;
    parentRunId: string | null;
    fellBackFrom: AiProviderId | null;
    previousText: string;
    issues: FlatZodIssue[];
    failures: AiAttemptFailure[];
  }): Promise<{ response: StructuredResponse<T> | null; attempts: number }> {
    let previousText = params.previousText;
    let issues = params.issues;
    let used = 0;

    for (let round = 1; round <= this.config.AI_MAX_REPAIR_ATTEMPTS; round += 1) {
      used += 1;
      const messages: ChatMessage[] = [
        ...params.baseMessages,
        { role: 'assistant', content: previousText },
        {
          role: 'user',
          content: renderRepairInstruction(params.jsonSchema, previousText, issues),
        },
      ];

      let record: AttemptRecord;
      try {
        record = await this.runOnce({
          provider: params.provider,
          // La reparación se registra con su propia operación para poder medirla aparte.
          operation: 'schema_repair',
          attempt: round,
          fellBackFrom: params.fellBackFrom,
          parentRunId: params.parentRunId,
          messages,
          jsonSchema: params.jsonSchema,
          schemaName: params.schemaName,
          context: params.context,
          // Temperatura mínima: aquí se quiere obediencia, no creatividad.
          temperature: 0,
          maxOutputTokens: params.maxOutputTokens,
          signal: params.signal,
        });
      } catch (error) {
        const aiError = isAiError(error)
          ? error
          : new AiError({ code: 'network', message: errorMessage(error) });
        params.failures.push({
          provider: params.provider.id,
          model: params.provider.model,
          attempt: round,
          code: aiError.code,
          message: `reparación: ${aiError.message}`,
        });
        return { response: null, attempts: used };
      }

      const validation = this.validate(params.schema, record.result.text, params.provider);
      if (validation.ok) {
        await this.telemetry.finish(record.runId, {
          status: 'repaired',
          usage: record.result.usage,
          latencyMs: record.latencyMs,
          costUsd: record.costUsd,
          responsePayload: record.result.raw,
          zodErrors: issues,
        });
        return {
          attempts: used,
          response: {
            data: validation.data,
            provider: params.provider.id,
            model: record.result.model,
            runId: record.runId,
            attempts: used,
            repairs: used,
            fellBackFrom: params.fellBackFrom,
            usage: record.result.usage,
            costUsd: record.costUsd,
            latencyMs: record.latencyMs,
            schemaDegraded: record.result.schemaDegraded === true,
          },
        };
      }

      await this.telemetry.finish(record.runId, {
        status: 'invalid_output',
        usage: record.result.usage,
        latencyMs: record.latencyMs,
        costUsd: record.costUsd,
        responsePayload: record.result.raw,
        zodErrors: validation.issues,
      });
      params.failures.push({
        provider: params.provider.id,
        model: params.provider.model,
        attempt: round,
        code: validation.code,
        message: `reparación: ${validation.issues
          .map((issue) => `${issue.path}: ${issue.message}`)
          .join('; ')}`,
      });

      previousText = record.result.text;
      issues = validation.issues;
    }

    return { response: null, attempts: used };
  }

  /** Generación de texto libre con la misma política de fallback y telemetría. */
  async generateText(request: TextRequest): Promise<TextResponse> {
    if (this.providers.length === 0) throw new AiExhaustedError([]);

    const baseMessages = buildMessages(request);
    const temperature = request.temperature ?? this.config.AI_TEMPERATURE;
    const maxOutputTokens = request.maxOutputTokens ?? this.config.AI_MAX_OUTPUT_TOKENS;
    const failures: AiAttemptFailure[] = [];
    let attempts = 0;

    for (let providerIndex = 0; providerIndex < this.providers.length; providerIndex += 1) {
      const provider = this.providers[providerIndex];
      if (provider === undefined) continue;
      const previous = providerIndex > 0 ? this.providers[providerIndex - 1] : undefined;
      const fellBackFrom = previous?.id ?? null;

      for (let attempt = 1; attempt <= this.config.AI_MAX_ATTEMPTS_PER_PROVIDER; attempt += 1) {
        attempts += 1;
        try {
          const record = await this.runOnce({
            provider,
            operation: request.operation,
            attempt,
            fellBackFrom,
            parentRunId: null,
            messages: baseMessages,
            context: request.context,
            temperature,
            maxOutputTokens,
            signal: request.signal,
          });

          await this.telemetry.finish(record.runId, {
            status: 'success',
            usage: record.result.usage,
            latencyMs: record.latencyMs,
            costUsd: record.costUsd,
            responsePayload: record.result.raw,
          });

          return {
            text: record.result.text,
            provider: provider.id,
            model: record.result.model,
            runId: record.runId,
            attempts,
            repairs: 0,
            fellBackFrom,
            usage: record.result.usage,
            costUsd: record.costUsd,
            latencyMs: record.latencyMs,
            schemaDegraded: false,
          };
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
          if (aiError.code === 'not_configured') break;
          const canRetry =
            aiError.retryable && attempt < this.config.AI_MAX_ATTEMPTS_PER_PROVIDER;
          if (!canRetry) break;
          await this.sleep(this.backoffMs(attempt, aiError.retryAfterMs), request.signal);
        }
      }
    }

    throw new AiExhaustedError(failures);
  }
}

let singleton: AiClient | null = null;

/** Cliente compartido por el proceso. Construido con el entorno validado. */
export function getAiClient(): AiClient {
  if (singleton === null) singleton = new AiClient();
  return singleton;
}

export function resetAiClient(): void {
  singleton = null;
}
