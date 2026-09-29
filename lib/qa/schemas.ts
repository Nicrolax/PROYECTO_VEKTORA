/**
 * VEKTORA · FASE 5 — Contrato de salida del AI Judge.
 *
 * La decisión que da forma a todo este módulo: **el modelo NO dice si se aprueba**.
 * Dice, criterio a criterio, si la evidencia lo satisface y qué parte de la evidencia lo
 * demuestra. El veredicto global lo calcula `policy.ts`, que es puro y determinista.
 *
 * Por qué. "¿Apruebas este entregable?" es un juicio global que un modelo resuelve por
 * impresión general: se deja llevar por un texto bien escrito y aprueba trabajo incompleto,
 * o se pone severo y rechaza trabajo correcto. "¿La evidencia demuestra AC-2? Cita la
 * parte que lo demuestra" es una tarea de extracción y localización, que es justo lo que un
 * modelo hace de forma fiable. Además convierte el umbral de aprobación en política
 * ajustable en vez de una decisión enterrada en un prompt.
 *
 * El esquema se construye con los ID de criterio REALES de la tarea, así que una respuesta
 * a la que le falte un criterio o que invente uno es un error de Zod, y el bucle de
 * auto-reparación de la FASE 2 se lo devuelve al modelo con el mensaje exacto. No hace
 * falta código de reparación específico del juez.
 */

import { z } from 'zod';

export const CRITERION_ID_RE = /^AC-\d{1,2}$/;

/** Veredicto por criterio. `unverifiable` no es un fallo: es "no puedo comprobarlo". */
export const CriterionVerdictSchema = z.strictObject({
  id: z.string().regex(CRITERION_ID_RE, 'debe ser el identificador del criterio: AC-1, AC-2, …'),
  verdict: z
    .enum(['pass', 'fail', 'unverifiable'])
    .describe(
      'pass: la evidencia lo demuestra. fail: la evidencia muestra que NO se cumple. ' +
        'unverifiable: la evidencia aportada no permite comprobarlo en ningún sentido.',
    ),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe('Cuán seguro estás de este veredicto concreto, de 0 a 1.'),
  evidence: z
    .string()
    .min(1)
    .max(800)
    .describe(
      'La parte EXACTA de la evidencia del proveedor que sustenta el veredicto, citada o ' +
        'referenciada. Si el veredicto es fail o unverifiable, di qué falta.',
    ),
  reasoning: z
    .string()
    .min(10)
    .max(800)
    .describe('Por qué esa evidencia satisface (o no) el criterio. Concreto, no genérico.'),
});

export type CriterionVerdict = z.infer<typeof CriterionVerdictSchema>;

export const QA_SUMMARY_MIN = 20;
export const QA_SUMMARY_MAX = 1200;

/**
 * Construye el esquema con los criterios reales de la tarea.
 *
 * Las refinements cruzadas son lo que hace que el auto-reparado funcione: un criterio
 * omitido produce "falta el veredicto de AC-3", que es una instrucción accionable, en vez
 * de un objeto válido al que simplemente le falta información.
 */
export function buildQaVerdictSchema(criterionIds: readonly string[]) {
  const expected = [...criterionIds];

  return z
    .strictObject({
      criteria: z
        .array(CriterionVerdictSchema)
        .min(1)
        .max(20)
        .describe('Un veredicto por CADA criterio de aceptación, en el mismo orden.'),
      summary: z
        .string()
        .min(QA_SUMMARY_MIN)
        .max(QA_SUMMARY_MAX)
        .describe(
          'Resumen para el proveedor: qué está bien y qué falta. Se le muestra tal cual, ' +
            'así que debe ser accionable y respetuoso.',
        ),
      blockingIssues: z
        .array(z.string().min(5).max(400))
        .max(10)
        .describe('Lo que impide aceptar el entregable. Vacío si no hay nada que impida.'),
    })
    .superRefine((value, ctx) => {
      const seen = new Set<string>();
      for (const [index, entry] of value.criteria.entries()) {
        if (seen.has(entry.id)) {
          ctx.addIssue({
            code: 'custom',
            path: ['criteria', index, 'id'],
            message: `${entry.id} aparece dos veces: cada criterio se evalúa una sola vez`,
          });
        }
        seen.add(entry.id);

        if (!expected.includes(entry.id)) {
          ctx.addIssue({
            code: 'custom',
            path: ['criteria', index, 'id'],
            message:
              `${entry.id} no es un criterio de esta tarea. Los criterios son: ` +
              `${expected.join(', ')}`,
          });
        }
      }

      for (const id of expected) {
        if (!seen.has(id)) {
          ctx.addIssue({
            code: 'custom',
            path: ['criteria'],
            message: `falta el veredicto de ${id}: hay que evaluar TODOS los criterios`,
          });
        }
      }
    });
}

export type QaVerdictSchema = ReturnType<typeof buildQaVerdictSchema>;
export type QaVerdict = z.infer<QaVerdictSchema>;

/**
 * Criterio de aceptación tal y como lo dejó el planificador en `project_tasks`.
 *
 * Se parsea con tolerancia a propósito: la columna es `jsonb` y puede contener filas
 * antiguas o escritas a mano. Un criterio malformado no debe impedir juzgar el resto.
 */
export const StoredCriterionSchema = z.object({
  id: z.string().min(1),
  criterion: z.string().min(1),
  verification: z.string().min(1).optional(),
});

export type StoredCriterion = z.infer<typeof StoredCriterionSchema>;

export interface ParsedCriteria {
  criteria: StoredCriterion[];
  /** Entradas que no se pudieron interpretar; se informan, no se ocultan. */
  malformed: number;
}

export function parseAcceptanceCriteria(raw: unknown): ParsedCriteria {
  if (!Array.isArray(raw)) return { criteria: [], malformed: 0 };

  const criteria: StoredCriterion[] = [];
  let malformed = 0;
  const seen = new Set<string>();

  for (const entry of raw) {
    const parsed = StoredCriterionSchema.safeParse(entry);
    if (!parsed.success) {
      malformed += 1;
      continue;
    }
    // Un id repetido rompería la correspondencia veredicto <-> criterio; se queda el primero.
    if (seen.has(parsed.data.id)) {
      malformed += 1;
      continue;
    }
    seen.add(parsed.data.id);
    criteria.push(parsed.data);
  }

  return { criteria, malformed };
}
