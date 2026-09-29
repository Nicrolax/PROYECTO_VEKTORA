/**
 * VEKTORA · FASE 2 — Taxonomía de errores de la capa de IA.
 *
 * El campo que gobierna toda la política de la capa es `retryable`:
 *   · `rate_limit` / `server` / `timeout` / `network`  -> se reintenta con backoff.
 *   · `auth` / `bad_request` / `blocked` / `truncated` -> se cede el turno al siguiente
 *     proveedor SIN gastar intentos: repetir daría exactamente el mismo resultado.
 *
 * `toRunStatus` traduce el error al ENUM `ai_run_status` de `db/schema.sql`. Para
 * `AiExhaustedError` resuelve por la CAUSA del último intento y no por "exhausted":
 * registrar `failed` cuando en realidad se agotó la cuota borra justo el dato que hace
 * falta para diagnosticar en la FASE 7.
 */

import type { AiProviderId, AiRunStatus } from './types';

export type AiErrorCode =
  /** Falta la clave del proveedor o la configuración es inválida. */
  | 'not_configured'
  /** La petición es inválida para el proveedor (400). */
  | 'bad_request'
  /** Clave inválida o sin permisos (401 / 403). */
  | 'auth'
  /** Cuota o límite de velocidad (429). */
  | 'rate_limit'
  /** Fallo del proveedor (5xx). */
  | 'server'
  /** Se agotó `AI_REQUEST_TIMEOUT_MS`. */
  | 'timeout'
  /** Fallo de red o de DNS antes de obtener respuesta. */
  | 'network'
  /** El proveedor bloqueó el prompt o la respuesta por políticas de seguridad. */
  | 'blocked'
  /** La respuesta se cortó por límite de tokens: el JSON está incompleto. */
  | 'truncated'
  /** No se pudo extraer JSON de la respuesta. */
  | 'invalid_json'
  /** El JSON se extrajo pero no valida contra el esquema Zod. */
  | 'invalid_output'
  /** La operación se canceló por `AbortSignal`. */
  | 'cancelled'
  /** Se recorrió toda la cadena de proveedores sin éxito. */
  | 'exhausted';

const RETRYABLE_CODES: ReadonlySet<AiErrorCode> = new Set<AiErrorCode>([
  'rate_limit',
  'server',
  'timeout',
  'network',
]);

/** Mapeo código -> `ai_run_status`. Lo consume la telemetría. */
const RUN_STATUS_BY_CODE: Readonly<Record<AiErrorCode, AiRunStatus>> = {
  not_configured: 'failed',
  bad_request: 'failed',
  auth: 'failed',
  rate_limit: 'rate_limited',
  server: 'failed',
  timeout: 'timeout',
  network: 'failed',
  blocked: 'failed',
  truncated: 'invalid_output',
  invalid_json: 'invalid_output',
  invalid_output: 'invalid_output',
  // El ENUM `ai_run_status` no tiene `cancelled`: una cancelación se registra como
  // `failed` con el motivo en `error_message`. Inventar una etiqueta haría que el INSERT
  // fallara con "invalid input value for enum" y se perdería la fila entera.
  cancelled: 'failed',
  exhausted: 'failed',
};

export interface AiErrorInit {
  code: AiErrorCode;
  message: string;
  provider?: AiProviderId | undefined;
  model?: string | undefined;
  /** Fuerza el valor por defecto derivado de `code`. */
  retryable?: boolean | undefined;
  /** Milisegundos indicados por la cabecera `Retry-After`, si vino. */
  retryAfterMs?: number | undefined;
  status?: number | undefined;
  details?: unknown;
  cause?: unknown;
}

export class AiError extends Error {
  readonly code: AiErrorCode;
  readonly provider: AiProviderId | undefined;
  readonly model: string | undefined;
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;
  readonly status: number | undefined;
  readonly details: unknown;

  constructor(init: AiErrorInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = 'AiError';
    this.code = init.code;
    this.provider = init.provider;
    this.model = init.model;
    this.retryable = init.retryable ?? RETRYABLE_CODES.has(init.code);
    this.retryAfterMs = init.retryAfterMs;
    this.status = init.status;
    this.details = init.details;
  }

  /** Línea compacta para logs; nunca incluye credenciales. */
  describe(): string {
    const origin = this.provider === undefined ? '' : ` [${this.provider}${this.model === undefined ? '' : `/${this.model}`}]`;
    return `${this.code}${origin}: ${this.message}`;
  }
}

/** Un intento fallido concreto dentro de la cadena de proveedores. */
export interface AiAttemptFailure {
  provider: AiProviderId;
  model: string;
  attempt: number;
  code: AiErrorCode;
  message: string;
}

/**
 * Se agotaron todos los proveedores. Conserva la lista completa de intentos para que la
 * FASE 3 pueda leerla (el planificador extrae de aquí los problemas de grafo) y para que
 * el diagnóstico no se pierda.
 */
export class AiExhaustedError extends AiError {
  readonly failures: AiAttemptFailure[];

  constructor(failures: readonly AiAttemptFailure[]) {
    const summary =
      failures.length === 0
        ? 'no hay ningún proveedor de IA configurado (define GROQ_API_KEY o GOOGLE_AI_API_KEY)'
        : failures
            .map(
              (failure) =>
                `${failure.provider}/${failure.model} #${failure.attempt} ${failure.code}: ${failure.message}`,
            )
            .join(' | ');
    super({
      code: 'exhausted',
      message: `VEKTORA/AI: se agotó la cadena de proveedores -> ${summary}`,
      retryable: false,
      details: failures,
    });
    this.name = 'AiExhaustedError';
    this.failures = [...failures];
  }

  /** Causa del último intento: es la que describe de verdad por qué se agotó. */
  get lastFailure(): AiAttemptFailure | undefined {
    return this.failures[this.failures.length - 1];
  }
}

export function isAiError(error: unknown): error is AiError {
  return error instanceof AiError;
}

export function errorMessage(error: unknown): string {
  if (error instanceof AiError) return error.describe();
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/**
 * Traduce un error al ENUM `ai_run_status`. Para `AiExhaustedError` resuelve por el código
 * del ÚLTIMO intento, no por `exhausted`.
 */
export function toRunStatus(error: unknown): AiRunStatus {
  if (error instanceof AiExhaustedError) {
    const last = error.lastFailure;
    if (last !== undefined) return RUN_STATUS_BY_CODE[last.code];
    return 'failed';
  }
  if (error instanceof AiError) return RUN_STATUS_BY_CODE[error.code];
  if (error instanceof Error && error.name === 'AbortError') return 'failed';
  return 'failed';
}

/** Issue de Zod aplanado. Va a `ai_runs.zod_errors` y al prompt de reparación. */
export interface FlatZodIssue {
  /** Ruta con puntos: `tasks.1.dependsOn.0`. `(raíz)` si es del objeto completo. */
  path: string;
  code: string;
  message: string;
}
