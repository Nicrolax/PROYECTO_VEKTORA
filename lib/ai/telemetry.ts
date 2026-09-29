/**
 * VEKTORA · FASE 2 — Telemetría de corridas de IA sobre la tabla `ai_runs`.
 *
 * Contrato: la telemetría NUNCA puede tumbar la operación de negocio. Todo fallo de
 * escritura se captura y se degrada a `null`. `start()` inserta la fila en estado
 * `pending` y `finish()` la cierra; así una corrida que se cuelga queda visible como
 * `pending` con `finished_at` nulo, que es precisamente la señal útil en la FASE 7.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { AiConfig } from './config';
import { isTelemetryConfigured } from './config';
import type { FlatZodIssue } from './errors';
import { truncateForLog } from './json';
import type {
  AiContext,
  AiOperation,
  AiProviderId,
  AiRunStatus,
  TokenUsage,
} from './types';

export interface RunStart {
  operation: AiOperation;
  provider: AiProviderId;
  model: string;
  attempt: number;
  fellBackFrom?: AiProviderId | null;
  parentRunId?: string | null;
  context?: AiContext | undefined;
  requestPayload?: unknown;
}

export interface RunFinish {
  status: AiRunStatus;
  usage?: TokenUsage | undefined;
  latencyMs?: number | undefined;
  costUsd?: number | undefined;
  responsePayload?: unknown;
  zodErrors?: FlatZodIssue[] | undefined;
  errorMessage?: string | undefined;
}

export interface TelemetrySink {
  start(run: RunStart): Promise<string | null>;
  finish(runId: string | null, patch: RunFinish): Promise<void>;
}

/** Sin telemetría (entorno local sin Supabase). */
export class NullTelemetrySink implements TelemetrySink {
  async start(): Promise<string | null> {
    return null;
  }

  async finish(): Promise<void> {
    /* no-op */
  }
}

export interface RecordedRun extends RunStart {
  id: string;
  status: AiRunStatus;
  finish?: RunFinish;
}

/** En memoria: útil en pruebas y para inspeccionar la cadena de fallback en local. */
export class InMemoryTelemetrySink implements TelemetrySink {
  readonly runs: RecordedRun[] = [];
  private sequence = 0;

  async start(run: RunStart): Promise<string | null> {
    this.sequence += 1;
    const id = `run_${this.sequence}`;
    this.runs.push({ ...run, id, status: 'pending' });
    return id;
  }

  async finish(runId: string | null, patch: RunFinish): Promise<void> {
    if (runId === null) return;
    const found = this.runs.find((run) => run.id === runId);
    if (found === undefined) return;
    found.status = patch.status;
    found.finish = patch;
  }

  reset(): void {
    this.runs.length = 0;
    this.sequence = 0;
  }
}

function sanitizePayload(
  payload: unknown,
  logPayloads: boolean,
  maxChars: number,
): Record<string, unknown> {
  if (!logPayloads || payload === undefined || payload === null) return {};
  try {
    const serialized = JSON.stringify(payload);
    if (serialized === undefined) return {};
    if (serialized.length <= maxChars) return JSON.parse(serialized) as Record<string, unknown>;
    return { truncated: true, preview: truncateForLog(serialized, maxChars) };
  } catch {
    return { unserializable: true };
  }
}

/** Persiste en `public.ai_runs` con el cliente `service_role`. */
export class SupabaseTelemetrySink implements TelemetrySink {
  constructor(
    private readonly client: SupabaseClient,
    private readonly logPayloads: boolean,
    private readonly maxChars: number,
  ) {}

  async start(run: RunStart): Promise<string | null> {
    try {
      const { data, error } = await this.client
        .from('ai_runs')
        .insert({
          operation: run.operation,
          provider: run.provider,
          model: run.model,
          status: 'pending' satisfies AiRunStatus,
          attempt: run.attempt,
          fell_back_from: run.fellBackFrom ?? null,
          parent_run_id: run.parentRunId ?? null,
          user_id: run.context?.userId ?? null,
          project_id: run.context?.projectId ?? null,
          task_id: run.context?.taskId ?? null,
          request_payload: sanitizePayload(
            run.requestPayload,
            this.logPayloads,
            this.maxChars,
          ),
        })
        .select('id')
        .single();

      if (error !== null) {
        reportTelemetryFailure('start', error.message);
        return null;
      }
      const id = (data as { id?: unknown } | null)?.id;
      return typeof id === 'string' ? id : null;
    } catch (error) {
      reportTelemetryFailure('start', error);
      return null;
    }
  }

  async finish(runId: string | null, patch: RunFinish): Promise<void> {
    if (runId === null) return;
    try {
      const { error } = await this.client
        .from('ai_runs')
        .update({
          status: patch.status,
          prompt_tokens: patch.usage?.promptTokens ?? null,
          completion_tokens: patch.usage?.completionTokens ?? null,
          total_tokens: patch.usage?.totalTokens ?? null,
          latency_ms: patch.latencyMs ?? null,
          cost_usd: patch.costUsd ?? 0,
          response_payload: sanitizePayload(
            patch.responsePayload,
            this.logPayloads,
            this.maxChars,
          ),
          zod_errors: patch.zodErrors ?? null,
          error_message: patch.errorMessage ?? null,
          finished_at: new Date().toISOString(),
        })
        .eq('id', runId);

      if (error !== null) reportTelemetryFailure('finish', error.message);
    } catch (error) {
      reportTelemetryFailure('finish', error);
    }
  }
}

function reportTelemetryFailure(stage: 'start' | 'finish', detail: unknown): void {
  const message = detail instanceof Error ? detail.message : String(detail);
  // No se relanza: la telemetría es best-effort.
  console.warn(`[vektora/ai] telemetría ${stage} falló: ${message}`);
}

export interface BuildTelemetryOptions {
  client?: SupabaseClient | undefined;
}

export function buildTelemetrySink(
  config: AiConfig,
  options: BuildTelemetryOptions = {},
): TelemetrySink {
  if (options.client !== undefined) {
    return new SupabaseTelemetrySink(
      options.client,
      config.AI_LOG_PAYLOADS,
      config.AI_LOG_PAYLOAD_MAX_CHARS,
    );
  }
  if (!isTelemetryConfigured(config)) return new NullTelemetrySink();
  return new LazySupabaseTelemetrySink(config);
}

/**
 * Retrasa la creación del cliente Supabase hasta la primera escritura, para que importar
 * la capa de IA no exija credenciales de base de datos.
 */
class LazySupabaseTelemetrySink implements TelemetrySink {
  private delegate: TelemetrySink | null = null;

  constructor(private readonly config: AiConfig) {}

  private async resolve(): Promise<TelemetrySink> {
    if (this.delegate !== null) return this.delegate;
    try {
      const { createSupabaseAdmin } = await import('@/lib/supabase/admin');
      const client = createSupabaseAdmin({
        url: this.config.SUPABASE_URL,
        serviceRoleKey: this.config.SUPABASE_SERVICE_ROLE_KEY,
      });
      this.delegate = new SupabaseTelemetrySink(
        client,
        this.config.AI_LOG_PAYLOADS,
        this.config.AI_LOG_PAYLOAD_MAX_CHARS,
      );
    } catch (error) {
      reportTelemetryFailure('start', error);
      this.delegate = new NullTelemetrySink();
    }
    return this.delegate;
  }

  async start(run: RunStart): Promise<string | null> {
    return (await this.resolve()).start(run);
  }

  async finish(runId: string | null, patch: RunFinish): Promise<void> {
    return (await this.resolve()).finish(runId, patch);
  }
}
