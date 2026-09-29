/**
 * VEKTORA · FASE 2 — Tipos compartidos de la capa de IA.
 *
 * Los literales de `AiOperation`, `AiProviderId` y `AiRunStatus` replican EXACTAMENTE los
 * ENUM `ai_operation`, `ai_provider` y `ai_run_status` de `db/schema.sql`. Si se añade un
 * valor allí, hay que añadirlo aquí: la telemetría escribe estos literales tal cual y
 * PostgreSQL rechaza cualquier etiqueta desconocida.
 */

/**
 * Proveedores implementados de la cadena de fallback. El ENUM `ai_provider` de la base
 * admite además `'other'`, reservado para un proveedor futuro: VEKTORA no lo escribe.
 */
export type AiProviderId = 'groq' | 'google';

/** Operaciones trazadas en `ai_runs.operation`. Coincide con el ENUM `ai_operation`. */
export type AiOperation =
  | 'project_planning'
  | 'task_decomposition'
  | 'embedding'
  | 'matching'
  /** Veredicto del AI Judge (FASE 5). En la base la etiqueta es `qa_judge`. */
  | 'qa_judge'
  | 'schema_repair'
  | 'summarization'
  | 'other';

/** Estados de `ai_runs.status`. Coincide con el ENUM `ai_run_status`. */
export type AiRunStatus =
  | 'pending'
  | 'success'
  | 'invalid_output'
  | 'repaired'
  | 'failed'
  | 'timeout'
  | 'rate_limited';

/** Tipos de tarea de embedding admitidos por Google AI Studio. */
export type EmbeddingTaskType =
  | 'RETRIEVAL_DOCUMENT'
  | 'RETRIEVAL_QUERY'
  | 'SEMANTIC_SIMILARITY'
  | 'CLASSIFICATION'
  | 'CLUSTERING';

/** Contexto de negocio que se adjunta a la fila de `ai_runs`. */
export interface AiContext {
  userId?: string | null;
  projectId?: string | null;
  taskId?: string | null;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * Consumo de tokens. Todos los campos son opcionales porque no todas las APIs los
 * devuelven (`embedContent` de Google, por ejemplo, no trae `usageMetadata`).
 */
export interface TokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

/**
 * Subconjunto de JSON Schema que la capa produce a partir de Zod. Se mantiene laxo a
 * propósito: `toGeminiSchema` es quien decide qué puede traducirse al `Schema` de Google.
 */
export interface JsonSchemaObject {
  type?: string | string[];
  description?: string;
  enum?: unknown[];
  const?: unknown;
  format?: string;
  properties?: Record<string, JsonSchemaObject>;
  required?: string[];
  additionalProperties?: boolean | JsonSchemaObject;
  items?: JsonSchemaObject | JsonSchemaObject[];
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  pattern?: string;
  anyOf?: JsonSchemaObject[];
  oneOf?: JsonSchemaObject[];
  allOf?: JsonSchemaObject[];
  nullable?: boolean;
  title?: string;
  [key: string]: unknown;
}

export interface GenerateRequest {
  messages: ChatMessage[];
  temperature?: number | undefined;
  maxOutputTokens?: number | undefined;
  /** Pide salida JSON aunque no haya esquema. */
  json?: boolean | undefined;
  /** Esquema que debe cumplir la salida. Su presencia implica `json`. */
  jsonSchema?: JsonSchemaObject | undefined;
  /** Nombre lógico del esquema, para prompts y telemetría. */
  jsonSchemaName?: string | undefined;
  signal?: AbortSignal | undefined;
}

export interface GenerateResult {
  text: string;
  /** Modelo que realmente respondió (puede diferir del pedido: alias, versión). */
  model: string;
  usage: TokenUsage;
  finishReason?: string;
  /** Cuerpo crudo de la respuesta; va a `ai_runs.response_payload`. */
  raw?: unknown;
  /** true si hubo que degradar de structured output nativo a esquema-en-el-prompt. */
  schemaDegraded?: boolean;
}

export interface LlmProvider {
  readonly id: AiProviderId;
  readonly model: string;
  isConfigured(): boolean;
  generate(request: GenerateRequest): Promise<GenerateResult>;
}

export interface EmbedRequest {
  input: string[];
  dimensions?: number | undefined;
  taskType?: EmbeddingTaskType | undefined;
  signal?: AbortSignal | undefined;
}

export interface EmbedResult {
  vectors: number[][];
  model: string;
  dimensions: number;
  usage: TokenUsage;
}

export interface EmbeddingProvider {
  readonly id: AiProviderId;
  readonly model: string;
  readonly dimensions: number;
  isConfigured(): boolean;
  embed(request: EmbedRequest): Promise<EmbedResult>;
}
