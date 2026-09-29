/**
 * VEKTORA · FASE 2 — Estimación de `ai_runs.cost_usd`.
 *
 * Regla 2 del proyecto: infraestructura 100% gratuita. Groq y Google AI Studio se usan en
 * su free tier, así que el coste real es 0 y la columna existe para dos cosas: medir el
 * coste equivalente (cuánto costaría el mismo tráfico fuera del free tier) y estar
 * preparados si algún día se sale de él.
 *
 * La tabla es extensible: un modelo desconocido devuelve 0 en vez de fallar. Un coste mal
 * estimado no puede tumbar una operación de negocio.
 */

export interface ModelPricing {
  /** USD por millón de tokens de entrada. */
  inputPerMillion: number;
  /** USD por millón de tokens de salida (incluye los tokens de "thinking"). */
  outputPerMillion: number;
  /** true si en el free tier el coste efectivo es 0. */
  freeTier: boolean;
}

/**
 * Precios de referencia del tier de pago. En free tier el coste efectivo es 0; se conserva
 * la referencia para poder estimar el coste equivalente si se cambia `FREE_TIER`.
 */
export const MODEL_PRICING: Record<string, ModelPricing> = {
  'llama-3.3-70b-versatile': { inputPerMillion: 0.59, outputPerMillion: 0.79, freeTier: true },
  'llama-3.1-8b-instant': { inputPerMillion: 0.05, outputPerMillion: 0.08, freeTier: true },
  'gemini-2.5-flash': { inputPerMillion: 0.3, outputPerMillion: 2.5, freeTier: true },
  'gemini-2.5-flash-lite': { inputPerMillion: 0.1, outputPerMillion: 0.4, freeTier: true },
  'gemini-2.5-pro': { inputPerMillion: 1.25, outputPerMillion: 10, freeTier: false },
  'gemini-embedding-001': { inputPerMillion: 0.15, outputPerMillion: 0, freeTier: true },
  'text-embedding-004': { inputPerMillion: 0, outputPerMillion: 0, freeTier: true },
};

/**
 * Si es `true`, todo modelo marcado `freeTier` cuesta 0. Ponerlo en `false` hace que
 * `cost_usd` refleje el coste equivalente del tier de pago sin tocar el resto del código.
 */
export const ASSUME_FREE_TIER = true;

/** Normaliza alias del proveedor: `gemini-2.5-flash-001`, `models/gemini-2.5-flash`, … */
function normalizeModel(model: string): string {
  const bare = model.replace(/^models\//, '').trim();
  if (MODEL_PRICING[bare] !== undefined) return bare;

  // Coincidencia por prefijo más largo: cubre sufijos de versión y de fecha.
  let best = '';
  for (const key of Object.keys(MODEL_PRICING)) {
    if (bare.startsWith(key) && key.length > best.length) best = key;
  }
  return best === '' ? bare : best;
}

/** Coste estimado en USD. Un modelo no tarifado devuelve 0. */
export function estimateCostUsd(
  model: string,
  promptTokens: number,
  completionTokens: number,
): number {
  const pricing = MODEL_PRICING[normalizeModel(model)];
  if (pricing === undefined) return 0;
  if (ASSUME_FREE_TIER && pricing.freeTier) return 0;

  const input = (Math.max(0, promptTokens) / 1_000_000) * pricing.inputPerMillion;
  const output = (Math.max(0, completionTokens) / 1_000_000) * pricing.outputPerMillion;
  // 6 decimales: `ai_runs.cost_usd` es numeric(12,6).
  return Math.round((input + output) * 1_000_000) / 1_000_000;
}

/** `true` si el modelo está tarifado en la tabla. Lo usa `scripts/ai-check.ts`. */
export function isModelPriced(model: string): boolean {
  return MODEL_PRICING[normalizeModel(model)] !== undefined;
}
