/**
 * Validación de entorno, taxonomía de errores y tarifación.
 *
 * El caso que justifica la mitad de este archivo: pedir 1536 dimensiones a un modelo de
 * 768 es imposible (`outputDimensionality` solo recorta vía MRL, nunca amplía). Sin la
 * validación de arranque, eso se descubre como un 400 en producción con el plan ya
 * generado y pagado.
 */

import { describe, expect, it } from 'vitest';
import { aiConfigWarnings, isTelemetryConfigured, loadAiConfig } from '@/lib/ai/config';
import { describeEmbeddingModel, validateEmbeddingModel } from '@/lib/ai/embedding-models';
import { AiError, AiExhaustedError, errorMessage, isAiError, toRunStatus } from '@/lib/ai/errors';
import { estimateCostUsd, isModelPriced } from '@/lib/ai/pricing';
import { parseRetryAfter, statusToCode } from '@/lib/ai/providers/http';

const base = { GROQ_API_KEY: 'gsk_test', GOOGLE_AI_API_KEY: 'AIza_test' };

describe('loadAiConfig', () => {
  it('aplica los valores por defecto del free tier', () => {
    const config = loadAiConfig(base);
    // Los modelos por defecto caducan: `llama-3.3-70b-versatile` y `gemini-2.5-flash` se
    // retiraron en 2026 y devolvían 404. La fuente de verdad es `npm run ai:models`.
    expect(config.GROQ_MODEL).toBe('openai/gpt-oss-120b');
    expect(config.GOOGLE_AI_MODEL).toBe('gemini-3.6-flash');
    expect(config.AI_EMBEDDING_MODEL).toBe('gemini-embedding-001');
    expect(config.AI_EMBEDDING_DIMENSIONS).toBe(1536);
    expect(config.AI_PROVIDER_ORDER).toEqual(['groq', 'google']);
  });

  it('exige al menos una clave de proveedor', () => {
    expect(() => loadAiConfig({})).toThrowError(AiError);
    try {
      loadAiConfig({});
    } catch (error) {
      expect((error as AiError).code).toBe('not_configured');
    }
  });

  it('funciona degradado con una sola clave', () => {
    expect(() => loadAiConfig({ GOOGLE_AI_API_KEY: 'AIza_test' })).not.toThrow();
  });

  it('trata la cadena vacía como variable ausente', () => {
    expect(() => loadAiConfig({ GROQ_API_KEY: '   ', GOOGLE_AI_API_KEY: '' })).toThrowError(AiError);
  });

  it('parsea AI_PROVIDER_ORDER y descarta lo desconocido', () => {
    const config = loadAiConfig({ ...base, AI_PROVIDER_ORDER: 'google, groq, openai' });
    expect(config.AI_PROVIDER_ORDER).toEqual(['google', 'groq']);
  });

  it('rechaza un AI_PROVIDER_ORDER sin ningún proveedor válido', () => {
    expect(() => loadAiConfig({ ...base, AI_PROVIDER_ORDER: 'openai,anthropic' })).toThrowError(
      AiError,
    );
  });

  it('rechaza un retardo máximo menor que el base', () => {
    expect(() =>
      loadAiConfig({ ...base, AI_RETRY_BASE_DELAY_MS: '5000', AI_RETRY_MAX_DELAY_MS: '100' }),
    ).toThrowError(AiError);
  });

  it('RECHAZA el par imposible text-embedding-004 @ 1536', () => {
    expect(() =>
      loadAiConfig({
        ...base,
        AI_EMBEDDING_MODEL: 'text-embedding-004',
        AI_EMBEDDING_DIMENSIONS: '1536',
      }),
    ).toThrowError(/solo recorta|no puede dar 1536/);
  });

  it('acepta text-embedding-004 a 768, que sí es posible', () => {
    expect(() =>
      loadAiConfig({
        ...base,
        AI_EMBEDDING_MODEL: 'text-embedding-004',
        AI_EMBEDDING_DIMENSIONS: '768',
      }),
    ).not.toThrow();
  });

  it('booleanish acepta true/false/1/0', () => {
    expect(loadAiConfig({ ...base, AI_LOG_PAYLOADS: 'false' }).AI_LOG_PAYLOADS).toBe(false);
    expect(loadAiConfig({ ...base, AI_LOG_PAYLOADS: '1' }).AI_LOG_PAYLOADS).toBe(true);
  });

  it('la telemetría solo está configurada con URL y clave de servicio', () => {
    expect(isTelemetryConfigured(loadAiConfig(base))).toBe(false);
    const withDb = loadAiConfig({
      ...base,
      SUPABASE_URL: 'https://proyecto.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'service-key',
    });
    expect(isTelemetryConfigured(withDb)).toBe(true);
  });

  it('los avisos son informativos y no bloquean el arranque', () => {
    const warnings = aiConfigWarnings(loadAiConfig({ GOOGLE_AI_API_KEY: 'AIza_test' }));
    expect(warnings.some((warning) => warning.includes('GROQ_API_KEY'))).toBe(true);
    expect(warnings.some((warning) => warning.includes('ai_runs'))).toBe(true);
  });
});

describe('registro de modelos de embedding', () => {
  it('acepta los tamaños recomendados de gemini-embedding-001', () => {
    for (const dimensions of [3072, 1536, 768]) {
      expect(validateEmbeddingModel('gemini-embedding-001', dimensions).ok).toBe(true);
    }
  });

  it('avisa de un modelo dado de baja', () => {
    const result = validateEmbeddingModel('text-embedding-004', 768);
    expect(result.ok).toBe(true);
    expect(result.warning).toContain('2026-01-14');
  });

  it('un modelo no registrado se acepta con aviso', () => {
    const result = validateEmbeddingModel('modelo-inventado', 512);
    expect(result.ok).toBe(true);
    expect(result.warning).toContain('no está en el registro');
  });

  it('describeEmbeddingModel indica el recorte MRL', () => {
    expect(describeEmbeddingModel('gemini-embedding-001', 1536)).toContain('recortado desde 3072');
  });
});

describe('taxonomía de errores', () => {
  it('retryable se deriva del código', () => {
    for (const code of ['rate_limit', 'server', 'timeout', 'network'] as const) {
      expect(new AiError({ code, message: 'x' }).retryable).toBe(true);
    }
    for (const code of ['auth', 'bad_request', 'blocked', 'truncated'] as const) {
      expect(new AiError({ code, message: 'x' }).retryable).toBe(false);
    }
  });

  it('retryable puede forzarse: el desajuste de dimensiones NO se reintenta', () => {
    const error = new AiError({ code: 'invalid_output', message: 'dims', retryable: false });
    expect(error.retryable).toBe(false);
  });

  it('toRunStatus mapea al ENUM ai_run_status', () => {
    expect(toRunStatus(new AiError({ code: 'rate_limit', message: 'x' }))).toBe('rate_limited');
    expect(toRunStatus(new AiError({ code: 'invalid_output', message: 'x' }))).toBe('invalid_output');
    expect(toRunStatus(new AiError({ code: 'truncated', message: 'x' }))).toBe('invalid_output');
    expect(toRunStatus(new AiError({ code: 'timeout', message: 'x' }))).toBe('timeout');
    // `ai_run_status` no tiene `cancelled`: se degrada a `failed` en vez de romper el INSERT.
    expect(toRunStatus(new AiError({ code: 'cancelled', message: 'x' }))).toBe('failed');
    expect(toRunStatus(new Error('cualquier cosa'))).toBe('failed');
  });

  it('AiExhaustedError resuelve por la CAUSA del último intento, no por "exhausted"', () => {
    const exhausted = new AiExhaustedError([
      { provider: 'groq', model: 'llama', attempt: 1, code: 'server', message: '500' },
      { provider: 'google', model: 'gemini', attempt: 2, code: 'rate_limit', message: '429' },
    ]);
    // Registrar `failed` aquí borraría el dato que hace falta para diagnosticar la cuota.
    expect(toRunStatus(exhausted)).toBe('rate_limited');
    expect(exhausted.lastFailure?.provider).toBe('google');
  });

  it('sin proveedores, el mensaje dice qué variable falta', () => {
    expect(new AiExhaustedError([]).message).toContain('GROQ_API_KEY');
  });

  it('errorMessage y isAiError normalizan cualquier entrada', () => {
    expect(isAiError(new AiError({ code: 'auth', message: 'x' }))).toBe(true);
    expect(isAiError(new Error('x'))).toBe(false);
    expect(errorMessage('texto')).toBe('texto');
    expect(errorMessage(new Error('boom'))).toBe('boom');
    expect(errorMessage(new AiError({ code: 'auth', message: 'boom', provider: 'groq' }))).toContain(
      'auth [groq]',
    );
  });
});

describe('transporte HTTP', () => {
  it('traduce el estado al código que decide si se reintenta', () => {
    expect(statusToCode(400)).toBe('bad_request');
    expect(statusToCode(401)).toBe('auth');
    expect(statusToCode(403)).toBe('auth');
    expect(statusToCode(408)).toBe('timeout');
    expect(statusToCode(429)).toBe('rate_limit');
    expect(statusToCode(500)).toBe('server');
    expect(statusToCode(503)).toBe('server');
  });

  it('parsea Retry-After en segundos y como fecha HTTP', () => {
    expect(parseRetryAfter('2')).toBe(2000);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter('no es una fecha')).toBeUndefined();
    const now = Date.parse('2026-01-01T00:00:00Z');
    expect(parseRetryAfter('Thu, 01 Jan 2026 00:00:30 GMT', now)).toBe(30_000);
    // Una fecha pasada no produce una espera negativa.
    expect(parseRetryAfter('Thu, 01 Jan 2020 00:00:00 GMT', now)).toBe(0);
  });
});

describe('tarifación', () => {
  it('en free tier el coste es 0', () => {
    expect(estimateCostUsd('llama-3.3-70b-versatile', 10_000, 5_000)).toBe(0);
    expect(estimateCostUsd('gemini-2.5-flash', 10_000, 5_000)).toBe(0);
  });

  it('un modelo desconocido no rompe el cálculo', () => {
    expect(estimateCostUsd('modelo-inventado', 1_000, 1_000)).toBe(0);
    expect(isModelPriced('modelo-inventado')).toBe(false);
  });

  it('normaliza alias y sufijos de versión', () => {
    expect(isModelPriced('models/gemini-2.5-flash')).toBe(true);
    expect(isModelPriced('gemini-2.5-flash-001')).toBe(true);
  });
});
