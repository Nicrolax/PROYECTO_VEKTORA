/**
 * VEKTORA · FASE 2 — Construcción de la cadena de proveedores.
 *
 * El orden lo dicta `AI_PROVIDER_ORDER` (por defecto `groq,google`) y SOLO entran los
 * proveedores que tienen clave configurada: con una sola clave el sistema funciona
 * degradado en vez de fallar, que es lo que exige la regla de autonomía.
 */

import type { AiConfig } from '../config';
import type { AiProviderId, EmbeddingProvider, LlmProvider } from '../types';
import { GeminiProvider } from './gemini';
import { GeminiEmbeddingProvider } from './gemini-embeddings';
import { GroqProvider } from './groq';

export { GeminiProvider } from './gemini';
export { GeminiEmbeddingProvider, normalizeL2 } from './gemini-embeddings';
export { GroqProvider } from './groq';
export { parseRetryAfter, postJson, statusToCode } from './http';
export type { PostJsonParams, PostJsonResult } from './http';

/** Instancia un proveedor de generación por su id, sin comprobar si está configurado. */
export function createLlmProvider(id: AiProviderId, config: AiConfig): LlmProvider {
  return id === 'groq' ? new GroqProvider(config) : new GeminiProvider(config);
}

/**
 * Cadena de generación en orden de preferencia, filtrando los proveedores sin clave.
 * Devolver un array vacío es un estado válido: `AiClient` lo traduce en `AiExhaustedError`
 * con un mensaje que dice exactamente qué variable falta.
 */
export function buildProviderChain(config: AiConfig): LlmProvider[] {
  const seen = new Set<AiProviderId>();
  const chain: LlmProvider[] = [];

  for (const id of config.AI_PROVIDER_ORDER) {
    if (seen.has(id)) continue;
    seen.add(id);
    const provider = createLlmProvider(id, config);
    if (provider.isConfigured()) chain.push(provider);
  }
  return chain;
}

/**
 * Proveedor de embeddings. Groq no expone embeddings, así que la ruta es única: Google AI
 * Studio. Devuelve `null` si no hay clave, y el servicio lo convierte en un error de
 * configuración con mensaje accionable.
 */
export function buildEmbeddingProvider(config: AiConfig): EmbeddingProvider | null {
  const provider = new GeminiEmbeddingProvider(config);
  return provider.isConfigured() ? provider : null;
}
