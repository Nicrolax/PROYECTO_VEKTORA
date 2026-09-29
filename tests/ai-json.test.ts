/**
 * Extracción de JSON. Cada caso de aquí corresponde a una forma real en la que los
 * modelos abiertos incumplen `response_format`. Recuperar la respuesta en vez de
 * abandonar ahorra un reintento entero del proveedor.
 */

import { describe, expect, it } from 'vitest';
import { AiError } from '@/lib/ai/errors';
import {
  extractJson,
  findBalancedJson,
  removeTrailingCommas,
  stripCodeFences,
  truncateForLog,
} from '@/lib/ai/json';

describe('extractJson', () => {
  it('parsea JSON limpio', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('quita las vallas markdown con etiqueta de lenguaje', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('quita las vallas markdown sin etiqueta', () => {
    expect(extractJson('```\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('ignora el prefacio en prosa', () => {
    expect(extractJson('Claro, aquí tienes el plan:\n\n{"a":1}\n\n¡Espero que sirva!')).toEqual({
      a: 1,
    });
  });

  it('tolera comas colgantes', () => {
    expect(extractJson('{"a":1,"b":[1,2,],}')).toEqual({ a: 1, b: [1, 2] });
  });

  it('no se confunde con llaves dentro de una cadena', () => {
    expect(extractJson('{"a":"valor con } y { dentro"}')).toEqual({
      a: 'valor con } y { dentro',
    });
  });

  it('no se confunde con comillas escapadas', () => {
    expect(extractJson('{"a":"dijo \\"hola\\" y se fue"}')).toEqual({
      a: 'dijo "hola" y se fue',
    });
  });

  it('acepta un array de nivel superior', () => {
    expect(extractJson('[1,2,3]')).toEqual([1, 2, 3]);
  });

  it('recupera el JSON de una valla sin cerrar', () => {
    expect(extractJson('```json\n{"a":1}')).toEqual({ a: 1 });
  });

  it('lanza invalid_json si no hay nada recuperable', () => {
    expect(() => extractJson('no hay ningún objeto aquí')).toThrowError(AiError);
    try {
      extractJson('no hay ningún objeto aquí');
    } catch (error) {
      expect((error as AiError).code).toBe('invalid_json');
      expect((error as AiError).retryable).toBe(false);
    }
  });

  it('la respuesta vacía es invalid_json, no un objeto vacío', () => {
    expect(() => extractJson('   ')).toThrowError(AiError);
  });

  it('conserva el proveedor y el modelo en el error', () => {
    try {
      extractJson('nada', { provider: 'groq', model: 'llama-3.3-70b-versatile' });
    } catch (error) {
      expect((error as AiError).provider).toBe('groq');
      expect((error as AiError).model).toBe('llama-3.3-70b-versatile');
    }
  });
});

describe('primitivas', () => {
  it('stripCodeFences elige la valla más larga', () => {
    const text = '```json\n{"a":1}\n```\ny además\n```json\n{"b":2,"c":3}\n```';
    expect(stripCodeFences(text)).toBe('{"b":2,"c":3}');
  });

  it('findBalancedJson respeta las cadenas', () => {
    expect(findBalancedJson('ruido {"a":"}"} más ruido')).toBe('{"a":"}"}');
  });

  it('findBalancedJson devuelve null si nunca cierra', () => {
    expect(findBalancedJson('{"a":1')).toBeNull();
  });

  it('removeTrailingCommas no toca las comas dentro de cadenas', () => {
    expect(removeTrailingCommas('{"a":"uno, dos",}')).toBe('{"a":"uno, dos"}');
  });

  it('truncateForLog marca cuánto se recortó', () => {
    expect(truncateForLog('abcdef', 3)).toBe('abc… (+3 caracteres)');
    expect(truncateForLog('abc', 10)).toBe('abc');
    expect(truncateForLog('abc', 0)).toBe('');
  });
});
