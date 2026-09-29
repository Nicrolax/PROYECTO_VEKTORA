/**
 * Puente Zod -> JSON Schema -> `Schema` de Google, y prompts de reparación.
 *
 * Lo que se protege aquí es que `toGeminiSchema` FALLE de forma explícita ante lo que no
 * puede traducir, en vez de producir un esquema que miente sobre el contrato: si mintiera,
 * Gemini devolvería datos que Zod rechazaría después, y el fallo aparecería como
 * "el modelo no obedece" en lugar de como el bug de traducción que es.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  flattenZodIssues,
  renderRepairInstruction,
  renderSchemaInstruction,
  toGeminiSchema,
  toJsonSchema,
  UnsupportedSchemaError,
} from '@/lib/ai/schema';
import type { JsonSchemaObject } from '@/lib/ai/types';

const Sample = z.strictObject({
  code: z.string().regex(/^T-\d{2}$/),
  hours: z.number().positive(),
  tags: z.array(z.string()).min(1),
  level: z.enum(['low', 'high']),
  note: z.string().nullable(),
});

describe('toJsonSchema', () => {
  it('produce un objeto con propiedades y required', () => {
    const schema = toJsonSchema(Sample);
    expect(schema.type).toBe('object');
    expect(Object.keys(schema.properties ?? {})).toContain('code');
    expect(schema.required).toContain('hours');
  });

  it('no arrastra metadatos de JSON Schema', () => {
    const schema = toJsonSchema(Sample) as Record<string, unknown>;
    expect(schema['$schema']).toBeUndefined();
    expect(schema['$id']).toBeUndefined();
  });

  it('sobrevive a un esquema con refinements cruzadas', () => {
    const refined = z
      .strictObject({ a: z.number(), b: z.number() })
      .superRefine((value, ctx) => {
        if (value.a > value.b) {
          ctx.addIssue({ code: 'custom', path: ['a'], message: 'a debe ser <= b' });
        }
      });
    expect(() => toJsonSchema(refined)).not.toThrow();
  });
});

describe('toGeminiSchema', () => {
  it('traduce el caso normal conservando tipos y required', () => {
    const translated = toGeminiSchema(toJsonSchema(Sample));
    expect(translated.type).toBe('object');
    expect(translated.properties?.['hours']?.type).toBe('number');
    expect(translated.properties?.['tags']?.type).toBe('array');
  });

  it('poda lo que Google rechaza: additionalProperties, pattern, minLength', () => {
    const translated = toGeminiSchema({
      type: 'object',
      additionalProperties: false,
      properties: {
        code: { type: 'string', pattern: '^T-\\d{2}$', minLength: 4, description: 'código' },
      },
      required: ['code'],
    });
    const code = translated.properties?.['code'] as JsonSchemaObject;
    expect(code['pattern']).toBeUndefined();
    expect(code['minLength']).toBeUndefined();
    expect(translated['additionalProperties']).toBeUndefined();
    // La descripción SÍ se conserva: es lo que guía al modelo.
    expect(code.description).toBe('código');
  });

  it('añade propertyOrdering para estabilizar la salida', () => {
    const translated = toGeminiSchema({
      type: 'object',
      properties: { b: { type: 'string' }, a: { type: 'string' } },
    });
    expect(translated['propertyOrdering']).toEqual(['b', 'a']);
  });

  it('colapsa el patrón "T | null" de .nullable() a nullable:true', () => {
    const translated = toGeminiSchema({
      anyOf: [{ type: 'string' }, { type: 'null' }],
    });
    expect(translated.type).toBe('string');
    expect(translated.nullable).toBe(true);
  });

  it('colapsa el tipo unión ["string","null"]', () => {
    const translated = toGeminiSchema({ type: ['string', 'null'] });
    expect(translated.type).toBe('string');
    expect(translated.nullable).toBe(true);
  });

  it('rechaza $ref sin resolver', () => {
    expect(() => toGeminiSchema({ $ref: '#/$defs/Task' } as JsonSchemaObject)).toThrowError(
      UnsupportedSchemaError,
    );
  });

  it('rechaza oneOf, allOf y const', () => {
    expect(() => toGeminiSchema({ oneOf: [{ type: 'string' }] })).toThrowError(UnsupportedSchemaError);
    expect(() => toGeminiSchema({ allOf: [{ type: 'string' }] })).toThrowError(UnsupportedSchemaError);
    expect(() => toGeminiSchema({ type: 'string', const: 'x' } as JsonSchemaObject)).toThrowError(
      UnsupportedSchemaError,
    );
  });

  it('rechaza una unión real de dos tipos', () => {
    expect(() =>
      toGeminiSchema({ anyOf: [{ type: 'string' }, { type: 'number' }] }),
    ).toThrowError(UnsupportedSchemaError);
  });

  it('rechaza las tuplas (items como array)', () => {
    expect(() =>
      toGeminiSchema({ type: 'array', items: [{ type: 'string' }] as unknown as JsonSchemaObject }),
    ).toThrowError(UnsupportedSchemaError);
  });

  it('rechaza un esquema sin tipo en vez de inventarlo', () => {
    expect(() => toGeminiSchema({ description: 'sin tipo' })).toThrowError(UnsupportedSchemaError);
  });
});

describe('prompts', () => {
  it('la instrucción de esquema prohíbe explícitamente las vallas y el texto extra', () => {
    const instruction = renderSchemaInstruction({ type: 'object' });
    expect(instruction).toContain('EXCLUSIVAMENTE');
    expect(instruction).toContain('markdown');
  });

  it('la instrucción de reparación lista cada issue de forma accionable', () => {
    const instruction = renderRepairInstruction({ type: 'object' }, '{"a":1}', [
      { path: 'tasks.1.dependsOn.0', code: 'custom', message: 'cierra un ciclo' },
    ]);
    expect(instruction).toContain('tasks.1.dependsOn.0: cierra un ciclo [custom]');
    expect(instruction).toContain('COMPLETO');
  });

  it('la instrucción de reparación cubre el caso "ni siquiera era JSON"', () => {
    expect(renderRepairInstruction({ type: 'object' }, 'hola', [])).toContain(
      'no era JSON válido',
    );
  });
});

describe('flattenZodIssues', () => {
  it('aplana la ruta con puntos', () => {
    const result = Sample.safeParse({ code: 'X', hours: -1, tags: [], level: 'low', note: null });
    expect(result.success).toBe(false);
    if (result.success) return;
    const flat = flattenZodIssues(result.error.issues);
    expect(flat.length).toBeGreaterThan(0);
    expect(flat.every((issue) => typeof issue.path === 'string')).toBe(true);
    expect(flat.some((issue) => issue.path === 'hours')).toBe(true);
  });

  it('marca la raíz como "(raíz)"', () => {
    const result = z.strictObject({ a: z.string() }).safeParse('no es objeto');
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(flattenZodIssues(result.error.issues)[0]?.path).toBe('(raíz)');
  });
});
