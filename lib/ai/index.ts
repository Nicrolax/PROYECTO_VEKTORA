/**
 * VEKTORA · FASE 2 — API pública de la capa de IA.
 *
 * Todo el resto del sistema importa desde aquí (`@/lib/ai`) y nunca de los archivos
 * internos: así la cadena de fallback, la telemetría y la política de reintentos pueden
 * cambiar sin tocar a los consumidores.
 *
 *   import { getAiClient, getEmbeddingService } from '@/lib/ai';
 */

// --- Orquestador ---------------------------------------------------------------------
export { AiClient, getAiClient, resetAiClient } from './ai-client';
export type {
  AiClientOptions,
  AiResponseMeta,
  StructuredRequest,
  StructuredResponse,
  TextRequest,
  TextResponse,
} from './ai-client';

// --- Embeddings ----------------------------------------------------------------------
export {
  cosineSimilarity,
  EmbeddingService,
  getEmbeddingService,
  resetEmbeddingService,
  toPgVector,
} from './embeddings';
export type {
  EmbeddingServiceOptions,
  EmbedTextsRequest,
  EmbedTextsResponse,
} from './embeddings';
export { normalizeL2 } from './providers/gemini-embeddings';

// --- Configuración -------------------------------------------------------------------
export {
  AiEnvSchema,
  aiConfigWarnings,
  getAiConfig,
  isTelemetryConfigured,
  loadAiConfig,
  resetAiConfigCache,
} from './config';
export type { AiConfig, EnvSource } from './config';
export {
  describeEmbeddingModel,
  EMBEDDING_MODELS,
  validateEmbeddingModel,
} from './embedding-models';
export type { EmbeddingModelSpec, EmbeddingModelValidation } from './embedding-models';

// --- Errores -------------------------------------------------------------------------
export { AiError, AiExhaustedError, errorMessage, isAiError, toRunStatus } from './errors';
export type { AiAttemptFailure, AiErrorCode, AiErrorInit, FlatZodIssue } from './errors';

// --- Utilidades de bajo nivel (las usan los scripts y las pruebas) --------------------
export { extractJson, truncateForLog } from './json';
export { estimateCostUsd, isModelPriced, MODEL_PRICING } from './pricing';
export {
  flattenZodIssues,
  renderRepairInstruction,
  renderSchemaInstruction,
  toGeminiSchema,
  toJsonSchema,
  UnsupportedSchemaError,
} from './schema';

// --- Proveedores ---------------------------------------------------------------------
export {
  buildEmbeddingProvider,
  buildProviderChain,
  createLlmProvider,
  GeminiEmbeddingProvider,
  GeminiProvider,
  GroqProvider,
} from './providers';

// --- Telemetría ----------------------------------------------------------------------
export {
  buildTelemetrySink,
  InMemoryTelemetrySink,
  NullTelemetrySink,
  SupabaseTelemetrySink,
} from './telemetry';
export type { RunFinish, RunStart, TelemetrySink } from './telemetry';

// --- Tipos compartidos ---------------------------------------------------------------
export type {
  AiContext,
  AiOperation,
  AiProviderId,
  AiRunStatus,
  ChatMessage,
  EmbeddingProvider,
  EmbeddingTaskType,
  EmbedRequest,
  EmbedResult,
  GenerateRequest,
  GenerateResult,
  JsonSchemaObject,
  LlmProvider,
  TokenUsage,
} from './types';
