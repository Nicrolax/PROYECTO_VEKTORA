/**
 * VEKTORA · FASE 5 — Prompts del AI Judge.
 *
 * Dos decisiones de diseño que importan más que la redacción:
 *
 *   1. AL JUEZ NO SE LE DICE QUIÉN ENTREGÓ. Ni nombre, ni reputación, ni precio, ni
 *      cuántas veces lo intentó. Un modelo al que le cuentas que el proveedor tiene 5
 *      estrellas evalúa distinto, y eso convertiría la reputación en una profecía que se
 *      cumple sola: quien ya tiene puntos aprueba más fácil y gana más puntos. La
 *      escalada por intentos vive en la política, donde es una regla explícita y auditable,
 *      no un sesgo difuso dentro del prompt.
 *
 *   2. NO SE LE PIDE UNA NOTA NI UNA DECISIÓN. Solo veredictos por criterio con la
 *      evidencia citada. La nota y la decisión las calcula `policy.ts`.
 */

import type { StoredCriterion } from './schemas';

export const QA_SYSTEM_PROMPT = `Eres el evaluador automático de entregables de VEKTORA.

Tu única función es comprobar, criterio por criterio, si la evidencia aportada demuestra que
el criterio de aceptación se cumple. No decides si el entregable se aprueba: eso lo calcula
el sistema a partir de tus veredictos.

REGLAS INNEGOCIABLES

1. Evalúa SOLO contra los criterios de aceptación listados. Si algo te parece mejorable pero
   ningún criterio lo pide, no es un incumplimiento: anótalo en el resumen y ya está.

2. Usa "unverifiable" cuando la evidencia no te permita comprobar el criterio. NO adivines.
   "fail" significa que la evidencia muestra que el criterio NO se cumple; "unverifiable"
   significa que no hay con qué comprobarlo. Confundirlos cierra tareas que solo necesitaban
   una captura más.

3. CITA la evidencia. En el campo "evidence" pon la parte concreta del entregable que
   sustenta tu veredicto, no un resumen tuyo. Si no puedes citar nada, el veredicto no puede
   ser "pass".

4. La extensión no es calidad. Un texto largo, bien escrito o lleno de tecnicismos no
   demuestra nada por sí mismo. Un entregable breve que cumple los criterios los cumple.

5. Ajusta "confidence" con honestidad. Si la evidencia es indirecta o ambigua, bájala. Una
   confianza baja en un "pass" hace que el sistema pida más evidencia en vez de aprobar, que
   es exactamente lo que debe pasar cuando no estás seguro.

6. El resumen lo lee la persona que entregó el trabajo. Sé concreto y respetuoso: di qué
   falta y cómo se demuestra, no si el trabajo te parece bueno.

Responde ÚNICAMENTE con el JSON del esquema indicado.`;

export interface JudgeContext {
  projectTitle: string;
  projectObjective: string;
  taskCode: string;
  taskTitle: string;
  taskDescription: string | null;
  criteria: readonly StoredCriterion[];
  deliverableSummary: string | null;
  deliverableContent: string | null;
  artifacts: readonly unknown[];
  evidence: Readonly<Record<string, unknown>>;
}

const MAX_CONTENT_CHARS = 20_000;
const MAX_EVIDENCE_CHARS = 12_000;

/** Recorta por el final, avisando en el propio texto: un corte silencioso se juzga como falta. */
function clamp(value: string, limit: number, what: string): string {
  if (value.length <= limit) return value;
  return (
    `${value.slice(0, limit)}\n\n[...] ${what} recortado: se han omitido ` +
    `${value.length - limit} caracteres por límite de contexto. Si un criterio depende de ` +
    'la parte omitida, respóndelo como "unverifiable".'
  );
}

function renderJson(value: unknown, limit: number, what: string): string {
  let text: string;
  try {
    text = JSON.stringify(value, null, 2);
  } catch {
    text = String(value);
  }
  return clamp(text ?? 'null', limit, what);
}

export function renderJudgePrompt(context: JudgeContext): string {
  const criteria = context.criteria
    .map((criterion, index) => {
      const verification =
        criterion.verification === undefined
          ? '    Cómo se comprueba: no se especificó; usa tu criterio y baja la confianza.'
          : `    Cómo se comprueba: ${criterion.verification}`;
      return `${index + 1}. [${criterion.id}] ${criterion.criterion}\n${verification}`;
    })
    .join('\n');

  const sections: string[] = [
    `PROYECTO: ${context.projectTitle}`,
    `Objetivo del cliente: ${context.projectObjective}`,
    '',
    `TAREA ${context.taskCode}: ${context.taskTitle}`,
    context.taskDescription === null || context.taskDescription.trim() === ''
      ? '(sin descripción adicional)'
      : context.taskDescription,
    '',
    'CRITERIOS DE ACEPTACIÓN — emite un veredicto por cada uno:',
    criteria === '' ? '(la tarea no tiene criterios registrados)' : criteria,
    '',
    '=============== ENTREGABLE ===============',
  ];

  sections.push(
    context.deliverableSummary === null || context.deliverableSummary.trim() === ''
      ? 'Resumen del proveedor: (no aportó ninguno)'
      : `Resumen del proveedor:\n${clamp(context.deliverableSummary, 2_000, 'El resumen fue')}`,
  );

  sections.push(
    '',
    context.deliverableContent === null || context.deliverableContent.trim() === ''
      ? 'Contenido: (no aportó ninguno)'
      : `Contenido:\n${clamp(context.deliverableContent, MAX_CONTENT_CHARS, 'El contenido fue')}`,
  );

  sections.push(
    '',
    context.artifacts.length === 0
      ? 'Artefactos: (ninguno)'
      : `Artefactos (${context.artifacts.length}):\n${renderJson(
          context.artifacts,
          4_000,
          'El listado de artefactos fue',
        )}`,
  );

  const evidenceKeys = Object.keys(context.evidence);
  sections.push(
    '',
    evidenceKeys.length === 0
      ? 'Evidencia por criterio: (el proveedor no aportó evidencia estructurada)'
      : `Evidencia por criterio:\n${renderJson(
          context.evidence,
          MAX_EVIDENCE_CHARS,
          'La evidencia fue',
        )}`,
    '',
    '==========================================',
    '',
    'Evalúa ahora cada criterio contra ESTA evidencia. Recuerda: si no puedes citar la parte',
    'que lo demuestra, el veredicto no puede ser "pass".',
  );

  return sections.join('\n');
}
