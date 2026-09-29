/**
 * VEKTORA · FASE 2 — Extracción de JSON de la salida del modelo.
 *
 * Los modelos abiertos incumplen `response_format` con cierta frecuencia: envuelven la
 * respuesta en vallas markdown, la preceden de prosa ("Aquí tienes el plan:") o dejan una
 * coma colgante. Abandonar por eso costaría un reintento entero del proveedor, así que se
 * intenta recuperar el JSON antes de declarar la salida inválida.
 *
 * El escaneo es consciente de las cadenas: una llave dentro de un string (`"a{b"`) o una
 * comilla escapada (`"a\\"b"`) no altera el balance. Eso es justo lo que rompe a las
 * implementaciones ingenuas basadas en `indexOf('{')` / `lastIndexOf('}')`.
 */

import { AiError } from './errors';
import type { AiProviderId } from './types';

export interface ExtractJsonOptions {
  provider?: AiProviderId | undefined;
  model?: string | undefined;
}

/** Quita vallas markdown ```json … ``` conservando el contenido. */
export function stripCodeFences(text: string): string {
  const fenced = /```[ \t]*([A-Za-z0-9_-]*)[ \t]*\r?\n([\s\S]*?)```/g;
  let best: string | null = null;
  let match: RegExpExecArray | null;

  while ((match = fenced.exec(text)) !== null) {
    const language = (match[1] ?? '').toLowerCase();
    const body = match[2] ?? '';
    if (language === '' || language === 'json' || language === 'json5') {
      if (best === null || body.length > best.length) best = body;
    }
  }

  if (best !== null) return best.trim();
  // Valla sin cerrar: el modelo se quedó sin tokens justo al final.
  const open = /```[ \t]*[A-Za-z0-9_-]*[ \t]*\r?\n/.exec(text);
  if (open !== null) return text.slice(open.index + open[0].length).trim();
  return text.trim();
}

/**
 * Primer valor JSON balanceado (objeto o array) que aparezca en el texto.
 * Devuelve `null` si no hay ninguno completo.
 */
export function findBalancedJson(text: string): string | null {
  for (let start = 0; start < text.length; start += 1) {
    const char = text[start];
    if (char !== '{' && char !== '[') continue;

    const closing = char === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let index = start; index < text.length; index += 1) {
      const current = text[index];
      if (current === undefined) break;

      if (inString) {
        if (escaped) escaped = false;
        else if (current === '\\') escaped = true;
        else if (current === '"') inString = false;
        continue;
      }

      if (current === '"') {
        inString = true;
        continue;
      }
      if (current === '{' || current === '[') depth += 1;
      else if (current === '}' || current === ']') {
        depth -= 1;
        if (depth === 0) {
          // Solo vale si cerró con el carácter del mismo tipo con el que abrió.
          return current === closing ? text.slice(start, index + 1) : null;
        }
      }
    }
  }
  return null;
}

/** Elimina comas colgantes antes de `}` o `]`, respetando las cadenas. */
export function removeTrailingCommas(json: string): string {
  let out = '';
  let inString = false;
  let escaped = false;

  for (let index = 0; index < json.length; index += 1) {
    const char = json[index];
    if (char === undefined) break;

    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }

    if (char === ',') {
      let lookahead = index + 1;
      while (lookahead < json.length && /\s/.test(json[lookahead] ?? '')) lookahead += 1;
      const next = json[lookahead];
      if (next === '}' || next === ']') continue; // coma colgante: se descarta
    }
    out += char;
  }
  return out;
}

/**
 * Extrae y parsea el JSON de la respuesta del modelo.
 * Lanza `AiError` con código `invalid_json` si no hay nada recuperable.
 */
export function extractJson(text: string, options: ExtractJsonOptions = {}): unknown {
  const raw = typeof text === 'string' ? text : '';
  if (raw.trim() === '') {
    throw new AiError({
      code: 'invalid_json',
      message: 'VEKTORA/AI: la respuesta del modelo está vacía',
      provider: options.provider,
      model: options.model,
    });
  }

  const candidates: string[] = [];
  const push = (value: string): void => {
    const trimmed = value.trim();
    if (trimmed !== '' && !candidates.includes(trimmed)) candidates.push(trimmed);
  };

  const unfenced = stripCodeFences(raw);
  push(unfenced);
  push(raw);

  const balancedFromUnfenced = findBalancedJson(unfenced);
  if (balancedFromUnfenced !== null) push(balancedFromUnfenced);
  const balancedFromRaw = findBalancedJson(raw);
  if (balancedFromRaw !== null) push(balancedFromRaw);

  for (const candidate of candidates) {
    for (const attempt of [candidate, removeTrailingCommas(candidate)]) {
      try {
        return JSON.parse(attempt) as unknown;
      } catch {
        /* siguiente candidato */
      }
    }
  }

  throw new AiError({
    code: 'invalid_json',
    message:
      'VEKTORA/AI: no se pudo extraer JSON de la respuesta del modelo -> ' +
      truncateForLog(raw, 400),
    provider: options.provider,
    model: options.model,
  });
}

/** Recorta para logs y para `ai_runs.request_payload` / `response_payload`. */
export function truncateForLog(value: string, maxChars: number): string {
  if (maxChars <= 0) return '';
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}… (+${value.length - maxChars} caracteres)`;
}
