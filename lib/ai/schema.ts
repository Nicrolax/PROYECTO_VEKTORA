/**
 * VEKTORA · FASE 2 — Puente Zod -> JSON Schema -> `Schema` de Google, y los prompts de
 * esquema y de reparación.
 *
 * Tres piezas distintas que conviven aquí porque comparten el mismo modelo de datos:
 *
 *  1. `toJsonSchema`: contrato canónico derivado del Zod estricto. Es lo que viaja en el
 *     system prompt de Groq y lo que se registra en `ai_runs.request_payload`.
 *  2. `toGeminiSchema`: traducción al subconjunto OpenAPI que acepta `responseSchema`.
 *     Google NO admite `additionalProperties`, `pattern`, `$ref`, `const` ni los
 *     combinadores `oneOf`/`allOf`; lo que no se puede representar se poda, y lo que no se
 *     puede poda sin mentir sobre el contrato lanza `UnsupportedSchemaError` para que el
 *     adaptador degrade a esquema-en-el-prompt.
 *  3. `renderRepairInstruction`: el mensaje que convierte los issues de Zod en una orden de
 *     corrección para el propio modelo. Es el corazón de la auto-reparación.
 */

import { z } from 'zod';
import type { FlatZodIssue } from './errors';
import { AiError } from './errors';
import type { JsonSchemaObject } from './types';

/** El esquema no puede representarse en el subconjunto que acepta Google. */
export class UnsupportedSchemaError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`VEKTORA/AI: esquema no representable para responseSchema -> ${reason}`);
    this.name = 'UnsupportedSchemaError';
    this.reason = reason;
  }
}

/**
 * Zod estricto -> JSON Schema.
 *
 * Zod 4 trae `z.toJSONSchema` nativo. Se comprueba en tiempo de ejecución para no acoplar
 * la capa a una versión concreta: si no estuviera disponible, se degrada a un esquema
 * mínimo y el modelo se guía por el prompt (la validación real la sigue haciendo Zod).
 */
export function toJsonSchema(schema: z.ZodType<unknown>): JsonSchemaObject {
  const converter = (z as unknown as {
    toJSONSchema?: (input: unknown, options?: Record<string, unknown>) => unknown;
  }).toJSONSchema;

  if (typeof converter !== 'function') return { type: 'object' };

  try {
    const produced = converter(schema, {
      target: 'draft-7',
      io: 'output',
      // Un refinement o un transform no tienen representación en JSON Schema: se aceptan
      // como `any` en vez de hacer fallar toda la conversión.
      unrepresentable: 'any',
      cycles: 'ref',
    });
    if (isJsonSchemaObject(produced)) return stripSchemaMetadata(produced);
    return { type: 'object' };
  } catch (error) {
    throw new AiError({
      code: 'bad_request',
      message: `VEKTORA/AI: no se pudo convertir el esquema Zod a JSON Schema -> ${
        error instanceof Error ? error.message : String(error)
      }`,
      cause: error,
    });
  }
}

function isJsonSchemaObject(value: unknown): value is JsonSchemaObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Quita `$schema`, `$id` y demás metadatos que no aportan nada al modelo. */
function stripSchemaMetadata(schema: JsonSchemaObject): JsonSchemaObject {
  const { $schema: _schema, $id: _id, ...rest } = schema as Record<string, unknown>;
  return rest as JsonSchemaObject;
}

// ---------------------------------------------------------------------------------------
// Traducción al `Schema` de Google
// ---------------------------------------------------------------------------------------

/** Claves que Google ignora o rechaza en `responseSchema`. */
const GEMINI_DROPPED_KEYS: ReadonlySet<string> = new Set([
  'additionalProperties',
  'pattern',
  'minLength',
  'maxLength',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'default',
  'examples',
  'title',
  '$schema',
  '$id',
  '$defs',
  'definitions',
]);

const GEMINI_TYPES: ReadonlySet<string> = new Set([
  'string',
  'number',
  'integer',
  'boolean',
  'array',
  'object',
  'null',
]);

/**
 * JSON Schema -> subconjunto OpenAPI de Google.
 * Lanza `UnsupportedSchemaError` ante construcciones que cambiarían el significado del
 * contrato si se podaran (referencias, combinadores, tuplas heterogéneas).
 */
export function toGeminiSchema(schema: JsonSchemaObject): JsonSchemaObject {
  return convert(schema, '(raíz)');
}

function convert(schema: JsonSchemaObject, path: string): JsonSchemaObject {
  if ('$ref' in schema) {
    throw new UnsupportedSchemaError(`${path}: hay una referencia $ref sin resolver`);
  }
  if (schema['oneOf'] !== undefined || schema['allOf'] !== undefined) {
    throw new UnsupportedSchemaError(`${path}: oneOf/allOf no están soportados`);
  }
  if (schema['const'] !== undefined) {
    throw new UnsupportedSchemaError(`${path}: const no está soportado`);
  }

  const out: JsonSchemaObject = {};

  // `anyOf` solo es traducible cuando es el patrón "T | null" que genera `.nullable()`.
  const anyOf = schema.anyOf;
  if (Array.isArray(anyOf)) {
    const nonNull = anyOf.filter((entry) => entry.type !== 'null');
    const hasNull = anyOf.length !== nonNull.length;
    const only = nonNull[0];
    if (nonNull.length !== 1 || only === undefined) {
      throw new UnsupportedSchemaError(`${path}: anyOf con más de una alternativa real`);
    }
    const converted = convert(only, path);
    if (hasNull) converted.nullable = true;
    if (typeof schema.description === 'string') converted.description = schema.description;
    return converted;
  }

  // Tipo. `['string','null']` se colapsa a string + nullable.
  const rawType = schema.type;
  if (Array.isArray(rawType)) {
    const nonNull = rawType.filter((entry) => entry !== 'null');
    const first = nonNull[0];
    if (nonNull.length !== 1 || first === undefined) {
      throw new UnsupportedSchemaError(`${path}: tipo unión no soportado (${rawType.join('|')})`);
    }
    out.type = first;
    if (nonNull.length !== rawType.length) out.nullable = true;
  } else if (typeof rawType === 'string') {
    if (!GEMINI_TYPES.has(rawType)) {
      throw new UnsupportedSchemaError(`${path}: tipo "${rawType}" no soportado`);
    }
    out.type = rawType;
  }

  if (schema.nullable === true) out.nullable = true;
  if (typeof schema.description === 'string') out.description = schema.description;
  if (typeof schema.format === 'string') out.format = schema.format;
  if (Array.isArray(schema.enum)) out.enum = schema.enum.map((value) => String(value));
  if (typeof schema.minItems === 'number') out.minItems = schema.minItems;
  if (typeof schema.maxItems === 'number') out.maxItems = schema.maxItems;
  if (typeof schema.minimum === 'number') out.minimum = schema.minimum;
  if (typeof schema.maximum === 'number') out.maximum = schema.maximum;

  if (schema.properties !== undefined) {
    const properties: Record<string, JsonSchemaObject> = {};
    const ordering: string[] = [];
    for (const [key, value] of Object.entries(schema.properties)) {
      properties[key] = convert(value, `${path}.${key}`);
      ordering.push(key);
    }
    out.properties = properties;
    // `propertyOrdering` reduce la variabilidad de la salida entre llamadas.
    out['propertyOrdering'] = ordering;
    if (Array.isArray(schema.required)) out.required = [...schema.required];
    if (out.type === undefined) out.type = 'object';
  }

  if (schema.items !== undefined) {
    if (Array.isArray(schema.items)) {
      throw new UnsupportedSchemaError(`${path}: tuplas (items como array) no soportadas`);
    }
    out.items = convert(schema.items, `${path}[]`);
    if (out.type === undefined) out.type = 'array';
  }

  // Las claves de GEMINI_DROPPED_KEYS no se copian nunca: son restricciones que Google
  // ignora o rechaza, y que Zod sigue aplicando del lado de VEKTORA. Se comprueba aquí
  // para que añadir una clave nueva al esquema no la cuele en silencio.
  for (const key of Object.keys(out)) {
    if (GEMINI_DROPPED_KEYS.has(key)) delete out[key];
  }

  if (out.type === undefined) {
    throw new UnsupportedSchemaError(`${path}: el esquema no declara tipo`);
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------------------

/** Instrucción de esquema que se inyecta en el system prompt (Groq, y Gemini degradado). */
export function renderSchemaInstruction(schema: JsonSchemaObject): string {
  return [
    'FORMATO DE RESPUESTA OBLIGATORIO',
    'Responde EXCLUSIVAMENTE con un único objeto JSON válido que cumpla este JSON Schema.',
    'Sin texto antes ni después, sin vallas markdown, sin comentarios y sin comas colgantes.',
    'No añadas propiedades que el esquema no declare.',
    '',
    '```json',
    JSON.stringify(schema, null, 2),
    '```',
  ].join('\n');
}

/**
 * Mensaje de reparación: la respuesta anterior del modelo + la lista exacta de lo que
 * falló. Se envía con `temperature: 0` porque aquí se busca obediencia, no creatividad.
 */
export function renderRepairInstruction(
  schema: JsonSchemaObject,
  previousText: string,
  issues: readonly FlatZodIssue[],
): string {
  const detail =
    issues.length === 0
      ? '- la respuesta anterior no era JSON válido'
      : issues.map((issue) => `- ${issue.path}: ${issue.message} [${issue.code}]`).join('\n');

  return [
    'TU RESPUESTA ANTERIOR NO CUMPLE EL CONTRATO. Corrígela.',
    '',
    'Problemas detectados por el validador:',
    detail,
    '',
    'Reglas de la corrección:',
    '1. Devuelve el objeto JSON COMPLETO y corregido, no un fragmento ni un diff.',
    '2. Conserva todo el contenido válido de tu respuesta anterior; cambia solo lo señalado.',
    '3. Sin texto fuera del JSON, sin vallas markdown, sin comentarios.',
    '',
    'JSON Schema que debe cumplirse:',
    '```json',
    JSON.stringify(schema, null, 2),
    '```',
  ].join('\n');
}

/** Issues de Zod -> forma plana para `ai_runs.zod_errors` y para el prompt de reparación. */
export function flattenZodIssues(issues: readonly z.core.$ZodIssue[]): FlatZodIssue[] {
  return issues.map((issue) => ({
    path: issue.path.length === 0 ? '(raíz)' : issue.path.map((part) => String(part)).join('.'),
    code: String(issue.code ?? 'custom'),
    message: issue.message,
  }));
}
