/**
 * VEKTORA · FASE 2 — Transporte HTTP común a todos los adaptadores.
 *
 * Concentra aquí tres cosas que, repetidas por proveedor, siempre acaban divergiendo:
 *   · el timeout de `AI_REQUEST_TIMEOUT_MS` combinado con el `AbortSignal` del llamador,
 *   · la traducción de estado HTTP a `AiErrorCode` (de la que depende `retryable`),
 *   · la lectura de `Retry-After` en sus dos formatos (segundos y fecha HTTP).
 *
 * El cuerpo se lee SIEMPRE como texto antes de intentar parsear JSON: los proveedores
 * devuelven HTML o texto plano en varios modos de fallo, y un `res.json()` directo
 * escondería el error real detrás de un SyntaxError.
 */

import { AiError, type AiErrorCode } from '../errors';
import type { AiProviderId } from '../types';

export interface PostJsonParams {
  url: string;
  body: unknown;
  headers?: Record<string, string>;
  timeoutMs: number;
  provider: AiProviderId;
  model: string;
  signal?: AbortSignal | undefined;
}

export interface PostJsonResult {
  status: number;
  /** Cuerpo parseado, o `null` si la respuesta no era JSON. */
  json: unknown;
  text: string;
  headers: Headers;
}

/** Estado HTTP -> código de error. Es lo que decide si se reintenta o se cede el turno. */
export function statusToCode(status: number): AiErrorCode {
  if (status === 400 || status === 404 || status === 422) return 'bad_request';
  if (status === 401 || status === 403) return 'auth';
  if (status === 408) return 'timeout';
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'server';
  return 'bad_request';
}

/** `Retry-After` en segundos o como fecha HTTP. Devuelve milisegundos. */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;

  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);

  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now);
}

/** Combina el `AbortSignal` del llamador con el del timeout, sin filtrar listeners. */
function combineSignals(
  timeoutMs: number,
  external: AbortSignal | undefined,
): { signal: AbortSignal; dispose: () => void; timedOut: () => boolean } {
  const controller = new AbortController();
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const onExternalAbort = (): void => controller.abort();
  if (external !== undefined) {
    if (external.aborted) controller.abort();
    else external.addEventListener('abort', onExternalAbort, { once: true });
  }

  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose: () => {
      clearTimeout(timer);
      external?.removeEventListener('abort', onExternalAbort);
    },
  };
}

/** Extrae el mensaje de error del cuerpo, sea cual sea la forma que use el proveedor. */
function readErrorMessage(json: unknown, text: string): string {
  if (typeof json === 'object' && json !== null) {
    const error = (json as { error?: unknown }).error;
    if (typeof error === 'string' && error !== '') return error;
    if (typeof error === 'object' && error !== null) {
      const message = (error as { message?: unknown }).message;
      if (typeof message === 'string' && message !== '') return message;
    }
    const message = (json as { message?: unknown }).message;
    if (typeof message === 'string' && message !== '') return message;
  }
  const compact = text.replace(/\s+/g, ' ').trim();
  return compact.length > 300 ? `${compact.slice(0, 300)}…` : compact;
}

export async function postJson(params: PostJsonParams): Promise<PostJsonResult> {
  const combined = combineSignals(params.timeoutMs, params.signal);

  let response: Response;
  try {
    response = await fetch(params.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        ...(params.headers ?? {}),
      },
      body: JSON.stringify(params.body),
      signal: combined.signal,
    });
  } catch (error) {
    combined.dispose();
    if (combined.timedOut()) {
      throw new AiError({
        code: 'timeout',
        message: `VEKTORA/AI: ${params.provider} no respondió en ${params.timeoutMs} ms`,
        provider: params.provider,
        model: params.model,
        cause: error,
      });
    }
    if (params.signal?.aborted === true) {
      throw new AiError({
        code: 'cancelled',
        message: `VEKTORA/AI: la petición a ${params.provider} se canceló`,
        provider: params.provider,
        model: params.model,
        cause: error,
      });
    }
    throw new AiError({
      code: 'network',
      message: `VEKTORA/AI: fallo de red hablando con ${params.provider} -> ${
        error instanceof Error ? error.message : String(error)
      }`,
      provider: params.provider,
      model: params.model,
      cause: error,
    });
  }

  combined.dispose();

  const text = await response.text();
  let json: unknown = null;
  if (text.trim() !== '') {
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      json = null;
    }
  }

  if (!response.ok) {
    const detail = readErrorMessage(json, text);
    const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));

    // Un 404 que habla del modelo NO es una petición mal formada: es el nombre del modelo,
    // que el proveedor retiró. Tratarlo como `bad_request` esconde la causa detrás de un
    // mensaje genérico; como `not_configured`, la cadena cede el turno sin gastar intentos
    // y el mensaje dice exactamente qué hacer.
    if (response.status === 404 && /model/i.test(detail)) {
      throw new AiError({
        code: 'not_configured',
        message:
          `VEKTORA/AI: ${params.provider} no reconoce el modelo "${params.model}" -> ${detail} ` +
          '| Ejecuta `npm run ai:models` para ver los modelos que admiten tus claves y ' +
          'actualiza GROQ_MODEL / GOOGLE_AI_MODEL en .env.local.',
        provider: params.provider,
        model: params.model,
        status: response.status,
        details: json ?? text,
      });
    }

    throw new AiError({
      code: statusToCode(response.status),
      message: `VEKTORA/AI: ${params.provider} respondió ${response.status} -> ${detail}`,
      provider: params.provider,
      model: params.model,
      status: response.status,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      details: json ?? text,
    });
  }

  return { status: response.status, json, text, headers: response.headers };
}
