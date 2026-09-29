/**
 * VEKTORA · FASE 3 — Prompts del ProjectPlanner.
 *
 * El JSON Schema ya viaja aparte (lo inyecta la capa de IA de la FASE 2), así que aquí no
 * se repite la forma: se explican las reglas que un esquema no puede expresar — qué es una
 * tarea atómica, cómo se escribe un criterio verificable y la semántica de `dependsOn`.
 */

import { MAX_TASKS, MIN_TASKS } from './schemas';

export interface SkillCatalogEntry {
  slug: string;
  name: string;
  category: string | null;
}

export interface PlannerPromptInput {
  objective: string;
  /** Catálogo canónico de `public.skills` para que el modelo no invente slugs. */
  skills: readonly SkillCatalogEntry[];
  budgetTotal?: number | null;
  currency?: string;
  deadline?: string | null;
  /** Pistas del cliente: restricciones, exclusiones, contexto. */
  constraints?: readonly string[];
}

export const PLANNER_SYSTEM_PROMPT = [
  'Eres el ProjectPlanner autónomo de VEKTORA, una plataforma de resultados sin gestión',
  'humana intermedia. Conviertes un objetivo en lenguaje natural en un grafo acíclico',
  'dirigido (DAG) de tareas ejecutables por proveedores independientes.',
  '',
  'REGLAS DE DESCOMPOSICIÓN',
  `1. Entre ${MIN_TASKS} y ${MAX_TASKS} tareas. Prefiere pocas tareas gruesas a muchas`,
  '   triviales: cada tarea debe justificar su propio ciclo de asignación y revisión.',
  '2. Cada tarea es ATÓMICA y ENTREGABLE: la ejecuta una sola persona, produce un artefacto',
  '   concreto y se puede aceptar o rechazar sin depender de otra tarea en curso.',
  '3. Cada tarea es independiente en ejecución: si dos trabajos deben hacerse a la vez y',
  '   coordinados, son la misma tarea.',
  '',
  'REGLAS DEL GRAFO',
  '4. `dependsOn` lista los códigos de las tareas que deben COMPLETARSE ANTES que esta.',
  '5. El grafo debe ser ACÍCLICO. Si A depende de B, B no puede depender de A ni directa ni',
  '   indirectamente a través de otras tareas.',
  '6. Al menos una tarea debe tener `dependsOn` vacío: es por donde arranca el proyecto.',
  '7. No declares dependencias por costumbre. Solo si el entregable de la tarea upstream es',
  '   una entrada REAL de la tarea downstream. El paralelismo es valioso.',
  '8. Los códigos van en orden lógico de ejecución: T-01, T-02, T-03, …',
  '',
  'CRITERIOS DE ACEPTACIÓN',
  '9. Entre 1 y 6 por tarea, y deben ser verificables por un agente automático que solo ve',
  '   el entregable. "Diseño de buena calidad" no es verificable; "tres variantes en SVG a',
  '   1440px con la paleta indicada" sí lo es.',
  '10. `verification` describe la evidencia concreta que prueba el criterio.',
  '11. PROHIBIDO todo criterio que dependa de la acción de una persona: aprobación o firma',
  '    del cliente, visto bueno, validación por un responsable, reunión de revisión. En este',
  '    sistema NO HAY NADIE que pueda hacer eso, así que un criterio así no se cumple nunca:',
  '    la tarea agota sus intentos y TODAS las que dependen de ella quedan bloqueadas para',
  '    siempre. Pide en su lugar el artefacto que demostraría esa aprobación.',
  '       MAL:  "Aprobado por el cliente mediante firma digital"',
  '       BIEN: "El PDF incluye una sección de conformidad con los campos fecha, alcance',
  '             acordado y firmante, lista para rellenar"',
  '',
  'SKILLS, ESFUERZO Y PRESUPUESTO',
  '12. `requiredSkills` usa EXCLUSIVAMENTE slugs del catálogo que se te entrega. Si ninguno',
  '    encaja, usa el más cercano y menciona la especialidad exacta en `description`.',
  '13. `estimatedHours` son horas de trabajo efectivo de una persona competente.',
  '14. `budgetShare` es la fracción del presupuesto total de cada tarea. LA SUMA DE TODAS',
  '    LAS `budgetShare` DEBE SER 1.0. Reparte en proporción al esfuerzo y a la escasez de',
  '    la skill, no a partes iguales.',
  '',
  'Responde en el idioma del objetivo recibido.',
].join('\n');

function renderSkillCatalog(skills: readonly SkillCatalogEntry[]): string {
  if (skills.length === 0) {
    return '(catálogo vacío: usa slugs descriptivos en minúsculas con guiones)';
  }
  const byCategory = new Map<string, string[]>();
  for (const skill of skills) {
    const category = skill.category ?? 'otros';
    const bucket = byCategory.get(category) ?? [];
    bucket.push(skill.slug);
    byCategory.set(category, bucket);
  }
  return [...byCategory.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([category, slugs]) => `- ${category}: ${slugs.sort().join(', ')}`)
    .join('\n');
}

export function renderPlannerPrompt(input: PlannerPromptInput): string {
  const sections: string[] = [
    'OBJETIVO DEL CLIENTE',
    input.objective.trim(),
    '',
    'CATÁLOGO DE SKILLS DISPONIBLES (usa solo estos slugs)',
    renderSkillCatalog(input.skills),
  ];

  const budget = input.budgetTotal;
  if (budget !== null && budget !== undefined && budget > 0) {
    sections.push(
      '',
      'PRESUPUESTO',
      `Total disponible: ${budget} ${input.currency ?? 'USD'}. Reparte con budgetShare ` +
        '(fracciones que sumen 1.0).',
    );
  } else {
    sections.push(
      '',
      'PRESUPUESTO',
      'No hay presupuesto declarado. Usa budgetShare para expresar el peso relativo de ' +
        'cada tarea; la suma debe ser 1.0.',
    );
  }

  if (input.deadline !== null && input.deadline !== undefined) {
    sections.push(
      '',
      'FECHA LÍMITE',
      `${input.deadline}. Tenla en cuenta al estimar horas y al decidir qué puede ir en ` +
        'paralelo.',
    );
  }

  if (input.constraints !== undefined && input.constraints.length > 0) {
    sections.push(
      '',
      'RESTRICCIONES',
      ...input.constraints.map((constraint) => `- ${constraint}`),
    );
  }

  sections.push(
    '',
    'Devuelve el plan completo: título, resumen del enfoque y el DAG de tareas.',
  );

  return sections.join('\n');
}

/**
 * Refuerzo que se añade cuando el modelo ya falló por un motivo estructural concreto.
 * Complementa, no sustituye, al prompt de reparación genérico de la FASE 2.
 */
export function renderGraphHintPrompt(problems: readonly string[]): string {
  if (problems.length === 0) return '';
  return [
    'ATENCIÓN — el intento anterior tenía estos problemas de grafo:',
    ...problems.map((problem) => `- ${problem}`),
    '',
    'Recuerda: `dependsOn` apunta hacia ATRÁS (a lo que ya debe estar hecho) y el grafo no',
    'puede tener ciclos. Revisa cada dependencia antes de responder.',
  ].join('\n');
}
