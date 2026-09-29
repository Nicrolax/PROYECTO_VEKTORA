/**
 * VEKTORA · FASE 2 — Configuración de la capa de IA, validada con Zod estricto.
 *
 * Regla del proyecto: infraestructura 100% gratuita. Los valores por defecto apuntan a
 * los free tiers de Groq y Google AI Studio. Ninguna clave se imprime ni se persiste.
 *
 * La validación NO ocurre al importar el módulo (eso rompería `next build` en entornos
 * sin variables): `getAiConfig()` la ejecuta de forma perezosa y memoriza el resultado.
 */

import { z } from 'zod';
import { validateEmbeddingModel } from './embedding-models';
import { AiError } from './errors';

const booleanish = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((value) => value === true || value === 'true' || value === '1');

export const AiEnvSchema = z
  .object({
    // --- Groq (proveedor primario) ---
    GROQ_API_KEY: z.string().trim().min(1).optional(),
    GROQ_BASE_URL: z.string().url().default('https://api.groq.com/openai/v1'),
    /**
     * `llama-3.3-70b-versatile` se retiró el 2026-08-16; Groq indica `openai/gpt-oss-120b`
     * como reemplazo. Los catálogos cambian y lo que ve una cuenta concreta puede diferir
     * de la documentación: `npm run ai:models` lista lo que admite TU clave.
     */
    GROQ_MODEL: z.string().trim().min(1).default('openai/gpt-oss-120b'),

    // --- Google AI Studio (fallback + embeddings) ---
    GOOGLE_AI_API_KEY: z.string().trim().min(1).optional(),
    GOOGLE_AI_BASE_URL: z
      .string()
      .url()
      .default('https://generativelanguage.googleapis.com/v1beta'),
    /**
     * `gemini-2.5-flash` dejó de estar disponible para cuentas nuevas; la propia API
     * sugiere `gemini-3.6-flash` al rechazarlo. Confírmalo con `npm run ai:models`.
     */
    GOOGLE_AI_MODEL: z.string().trim().min(1).default('gemini-3.6-flash'),
    /**
     * Presupuesto de "thinking" de Gemini 2.5. 0 lo desactiva (más rápido y barato para
     * extracción estructurada). Si se omite, no se envía el parámetro y manda el default
     * del modelo.
     */
    GOOGLE_AI_THINKING_BUDGET: z.coerce.number().int().min(0).max(24576).optional(),

    // --- Embeddings (Google AI Studio, free tier; Groq no expone embeddings) ---
    /**
     * Debe producir el número de dimensiones de `vector(1536)` en db/schema.sql.
     * `gemini-embedding-001` es el único modelo vigente de AI Studio que da 1536:
     * su nativo es 3072 y MRL lo recorta. `text-embedding-004` es de 768 y solo es
     * válido con AI_EMBEDDING_DIMENSIONS<=768 (exige migrar el schema a vector(768)).
     * La combinación imposible la rechaza el `superRefine` de abajo.
     */
    AI_EMBEDDING_MODEL: z.string().trim().min(1).default('gemini-embedding-001'),
    AI_EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().default(1536),
    /** Tipo de tarea por defecto al vectorizar (afecta la geometría del embedding). */
    AI_EMBEDDING_TASK_TYPE: z
      .enum([
        'RETRIEVAL_DOCUMENT',
        'RETRIEVAL_QUERY',
        'SEMANTIC_SIMILARITY',
        'CLASSIFICATION',
        'CLUSTERING',
      ])
      .default('RETRIEVAL_DOCUMENT'),

    // --- Política de reintentos y fallback ---
    AI_PROVIDER_ORDER: z
      .string()
      .trim()
      .default('groq,google')
      .transform((value) =>
        value
          .split(',')
          .map((part) => part.trim().toLowerCase())
          .filter((part): part is 'groq' | 'google' => part === 'groq' || part === 'google'),
      )
      .refine((list) => list.length > 0, {
        message: 'AI_PROVIDER_ORDER debe listar al menos "groq" o "google"',
      }),
    AI_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(300_000).default(45_000),
    AI_MAX_ATTEMPTS_PER_PROVIDER: z.coerce.number().int().min(1).max(5).default(2),
    AI_MAX_REPAIR_ATTEMPTS: z.coerce.number().int().min(0).max(4).default(2),
    AI_RETRY_BASE_DELAY_MS: z.coerce.number().int().min(0).max(30_000).default(500),
    AI_RETRY_MAX_DELAY_MS: z.coerce.number().int().min(0).max(120_000).default(8_000),
    AI_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.2),
    AI_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(64).max(65_536).default(8_192),
    AI_EMBED_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(2),

    // --- Telemetría (tabla ai_runs) ---
    SUPABASE_URL: z.string().url().optional(),
    SUPABASE_SERVICE_ROLE_KEY: z.string().trim().min(1).optional(),
    AI_LOG_PAYLOADS: booleanish.default(true),
    AI_LOG_PAYLOAD_MAX_CHARS: z.coerce.number().int().min(0).max(200_000).default(8_000),
  })
  .superRefine((value, ctx) => {
    const hasGroq = Boolean(value.GROQ_API_KEY);
    const hasGoogle = Boolean(value.GOOGLE_AI_API_KEY);
    if (!hasGroq && !hasGoogle) {
      ctx.addIssue({
        code: 'custom',
        path: ['GROQ_API_KEY'],
        message:
          'Debe definirse al menos GROQ_API_KEY o GOOGLE_AI_API_KEY para usar la capa de IA.',
      });
    }
    if (value.AI_RETRY_MAX_DELAY_MS < value.AI_RETRY_BASE_DELAY_MS) {
      ctx.addIssue({
        code: 'custom',
        path: ['AI_RETRY_MAX_DELAY_MS'],
        message: 'AI_RETRY_MAX_DELAY_MS no puede ser menor que AI_RETRY_BASE_DELAY_MS.',
      });
    }

    // El par (modelo, dimensiones) tiene que ser físicamente posible: pedir 1536 a un
    // modelo de 768 solo se descubriría como 400 en producción.
    const embedding = validateEmbeddingModel(
      value.AI_EMBEDDING_MODEL,
      value.AI_EMBEDDING_DIMENSIONS,
    );
    if (!embedding.ok) {
      ctx.addIssue({
        code: 'custom',
        path: ['AI_EMBEDDING_DIMENSIONS'],
        message: embedding.error ?? 'Modelo de embedding incompatible con las dimensiones.',
      });
    }
  });

export type AiConfig = z.infer<typeof AiEnvSchema>;

export type EnvSource = Record<string, string | undefined>;

/** Valida un objeto de entorno y devuelve la configuración. Lanza `AiError` si falla. */
export function loadAiConfig(env: EnvSource = process.env): AiConfig {
  // Las claves ausentes deben llegar como `undefined`, no como cadena vacía.
  const cleaned: EnvSource = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string' && value.trim() === '') continue;
    if (value === undefined) continue;
    cleaned[key] = value;
  }

  const parsed = AiEnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(raíz)'}: ${issue.message}`)
      .join('; ');
    throw new AiError({
      code: 'not_configured',
      message: `VEKTORA/AI: configuración inválida -> ${detail}`,
      details: parsed.error.issues,
    });
  }
  return parsed.data;
}

let cached: AiConfig | null = null;

export function getAiConfig(): AiConfig {
  if (cached === null) cached = loadAiConfig();
  return cached;
}

/** Solo para pruebas y para recargar tras cambiar el entorno. */
export function resetAiConfigCache(): void {
  cached = null;
}

export function isTelemetryConfigured(config: AiConfig): boolean {
  return Boolean(config.SUPABASE_URL && config.SUPABASE_SERVICE_ROLE_KEY);
}

/**
 * Avisos no bloqueantes de la configuración activa (modelo deprecado, tamaño de embedding
 * no recomendado, modelo desconocido). Se exponen para que `scripts/ai-check.ts` y la
 * observabilidad de la FASE 7 los muestren sin ensuciar el arranque.
 */
export function aiConfigWarnings(config: AiConfig): string[] {
  const warnings: string[] = [];
  const embedding = validateEmbeddingModel(
    config.AI_EMBEDDING_MODEL,
    config.AI_EMBEDDING_DIMENSIONS,
  );
  if (embedding.warning !== undefined) warnings.push(embedding.warning);
  if (!config.GROQ_API_KEY) {
    warnings.push('GROQ_API_KEY ausente: no hay proveedor primario, solo Gemini.');
  }
  if (!config.GOOGLE_AI_API_KEY) {
    warnings.push(
      'GOOGLE_AI_API_KEY ausente: sin fallback de generación y sin embeddings ' +
        '(Groq no expone embeddings).',
    );
  }
  if (!isTelemetryConfigured(config)) {
    warnings.push('Sin SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY: no se escribirá en ai_runs.');
  }
  return warnings;
}
