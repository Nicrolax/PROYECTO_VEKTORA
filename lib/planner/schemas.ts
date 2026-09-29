/**
 * VEKTORA · FASE 3 — Contrato de salida del ProjectPlanner.
 *
 * La idea central de esta fase: los invariantes del DAG se expresan como refinements de
 * Zod, no como validación posterior. Así el bucle de auto-reparación de la FASE 2 recibe
 * mensajes como
 *
 *   tasks.3.dependsOn.0: "T-02" cierra un ciclo: T-02 → T-04 → T-02
 *
 * y el propio modelo corrige el grafo. El trigger `prevent_dag_cycles` de la FASE 1 queda
 * como red de seguridad en la base, no como primera línea de defensa.
 */

import { z } from 'zod';
import { findCycles, findDuplicateCodes, findReferenceProblems, formatCycle } from './dag';

/** `T-01`, `T-12`, o subtarea `T-03.1`. Debe coincidir con `project_tasks.code`. */
export const TASK_CODE_RE = /^T-\d{2}(?:\.\d{1,2})?$/;

/** Slug de skill: minúsculas, dígitos y guiones. Compatible con `skills.slug` (citext). */
export const SKILL_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const MIN_TASKS = 2;
export const MAX_TASKS = 24;

/** Tolerancia al comparar la suma de `budgetShare` con 1. */
export const BUDGET_SHARE_TOLERANCE = 0.02;

/**
 * Criterios que NINGÚN proveedor puede satisfacer por sí solo.
 *
 * Esto no es teoría: el planificador generó «Aprobado por el cliente mediante firma
 * digital» como criterio de aceptación de la primera tarea de un proyecto real. Ningún
 * proveedor autónomo puede conseguir la firma de una persona, así que esa tarea estaba
 * condenada a agotar sus intentos — y como era la raíz del grafo, **las otras nueve tareas
 * quedaron bloqueadas para siempre**. Un solo criterio mal escrito paró el proyecto entero.
 *
 * El prompt ya pedía criterios «verificables por un agente automático que solo ve el
 * entregable» y el modelo lo incumplió igual. Por eso está aquí: un refinement de Zod es
 * una garantía, un párrafo de prompt es una esperanza. Además, al fallar la validación, el
 * bucle de auto-reparación de la FASE 2 le devuelve el mensaje y el modelo lo reescribe
 * solo.
 *
 * Los patrones exigen verbo de aprobación + agente externo, no la palabra suelta: «el
 * documento describe el flujo de aprobación» debe seguir siendo válido. Un falso positivo
 * cuesta una ronda de reparación; un falso negativo bloquea un DAG entero.
 */
const HUMAN_GATED_PATTERNS: ReadonlyArray<{ re: RegExp; what: string }> = [
  {
    re: /\b(aprobad[oa]s?|validad[oa]s?|revisad[oa]s?|confirmad[oa]s?|firmad[oa]s?)\s+(por|con)\s+(el|la|los|las)?\s*(cliente|usuario final|propietari|dueñ|stakeholder|responsable|comit|direcci[oó]n|superior)/i,
    what: 'la aprobación de una persona',
  },
  { re: /\bfirma\s+(digital|electr[oó]nica|manuscrita|del?\s+cliente)/i, what: 'una firma' },
  { re: /\bvisto\s+bueno\b/i, what: 'el visto bueno de alguien' },
  { re: /\bsign[-\s]?off\b/i, what: 'un sign-off' },
  {
    re: /\b(approved|signed|validated)\s+by\s+(the\s+)?(client|customer|owner|stakeholder)/i,
    what: 'la aprobación de una persona',
  },
  {
    re: /\b(reuni[oó]n|llamada|demo\s+en\s+vivo|presentaci[oó]n)\s+(de|con)\s+(aprobaci[oó]n|el\s+cliente)/i,
    what: 'una reunión con el cliente',
  },
];

/** Devuelve qué dependencia humana contiene el texto, o `null` si no contiene ninguna. */
export function findHumanGate(text: string): string | null {
  for (const pattern of HUMAN_GATED_PATTERNS) {
    if (pattern.re.test(text)) return pattern.what;
  }
  return null;
}

export const AcceptanceCriterionSchema = z.strictObject({
  id: z
    .string()
    .regex(/^AC-\d{1,2}$/, 'debe tener la forma AC-1, AC-2, …')
    .describe('Identificador estable del criterio dentro de la tarea.'),
  criterion: z
    .string()
    .min(10)
    .max(400)
    .describe('Qué debe ser cierto para aceptar el entregable. Verificable, no subjetivo.'),
  verification: z
    .string()
    .min(10)
    .max(400)
    .describe('Cómo se comprueba: evidencia concreta que el AI Judge podrá evaluar.'),
})
  .superRefine((value, ctx) => {
    for (const field of ['criterion', 'verification'] as const) {
      const gate = findHumanGate(value[field]);
      if (gate === null) continue;
      ctx.addIssue({
        code: 'custom',
        path: [field],
        message:
          `este criterio depende de ${gate}, y el sistema no tiene intervención humana: ` +
          'ningún proveedor podría cumplirlo nunca y la tarea bloquearía a todas las que ' +
          'dependan de ella. Reescríbelo para que se pueda verificar MIRANDO EL ENTREGABLE ' +
          '(por ejemplo, en vez de "aprobado por el cliente", pide el artefacto concreto ' +
          'que demostraría esa aprobación, o elimina el criterio)',
      });
    }
  });

export const PlanTaskSchema = z.strictObject({
  code: z.string().regex(TASK_CODE_RE, 'debe tener la forma T-01 o T-01.1'),
  title: z.string().min(5).max(120),
  description: z
    .string()
    .min(20)
    .max(2000)
    .describe('Alcance de la tarea: qué incluye y qué queda fuera.'),
  acceptanceCriteria: z.array(AcceptanceCriterionSchema).min(1).max(6),
  requiredSkills: z
    .array(z.string().regex(SKILL_SLUG_RE, 'debe ser un slug en minúsculas con guiones'))
    .min(1)
    .max(6),
  estimatedHours: z.number().positive().max(200),
  /** Fracción del presupuesto total del proyecto. El conjunto debe sumar 1. */
  budgetShare: z.number().min(0).max(1),
  priority: z.number().int().min(1).max(5),
  dependsOn: z
    .array(z.string().regex(TASK_CODE_RE))
    .max(MAX_TASKS)
    .describe('Códigos de las tareas que deben completarse ANTES de esta.'),
});

export type PlanTask = z.infer<typeof PlanTaskSchema>;
export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterionSchema>;

/**
 * Plan completo. Las refinements cruzadas son la parte importante: sin ellas el modelo
 * produce con alegría grafos cíclicos o referencias a tareas que no existen.
 */
export const ProjectPlanSchema = z
  .strictObject({
    title: z.string().min(5).max(200).describe('Título corto y concreto del proyecto.'),
    summary: z
      .string()
      .min(30)
      .max(1200)
      .describe('Resumen del enfoque: cómo se llega del objetivo al resultado.'),
    tasks: z.array(PlanTaskSchema).min(MIN_TASKS).max(MAX_TASKS),
  })
  .superRefine((plan, ctx) => {
    const nodes = plan.tasks.map((task) => ({
      code: task.code,
      dependsOn: task.dependsOn,
      weight: task.estimatedHours,
    }));
    const indexByCode = new Map(plan.tasks.map((task, index) => [task.code, index]));

    // --- Códigos duplicados ---
    for (const code of findDuplicateCodes(nodes)) {
      const firstIndex = indexByCode.get(code) ?? 0;
      ctx.addIssue({
        code: 'custom',
        path: ['tasks', firstIndex, 'code'],
        message: `el código "${code}" está repetido; cada tarea necesita un código único`,
      });
    }

    // --- Referencias inválidas ---
    for (const problem of findReferenceProblems(nodes)) {
      const taskIndex = indexByCode.get(problem.code) ?? 0;
      const message =
        problem.kind === 'self'
          ? `"${problem.reference}" es la propia tarea: una tarea no puede depender de sí misma`
          : problem.kind === 'duplicate'
            ? `"${problem.reference}" aparece dos veces en dependsOn`
            : `"${problem.reference}" no corresponde a ninguna tarea del plan`;
      ctx.addIssue({
        code: 'custom',
        path: ['tasks', taskIndex, 'dependsOn', problem.index],
        message,
      });
    }

    // --- Ciclos ---
    for (const cycle of findCycles(nodes)) {
      const head = cycle[0];
      if (head === undefined) continue;
      const taskIndex = indexByCode.get(head) ?? 0;
      const task = plan.tasks[taskIndex];
      const next = cycle[1] ?? head;
      const depIndex = task?.dependsOn.indexOf(next) ?? -1;
      ctx.addIssue({
        code: 'custom',
        path:
          depIndex >= 0
            ? ['tasks', taskIndex, 'dependsOn', depIndex]
            : ['tasks', taskIndex, 'dependsOn'],
        message:
          `cierra un ciclo: ${formatCycle(cycle)}. El grafo de tareas debe ser acíclico: ` +
          'elimina una de esas dependencias.',
      });
    }

    // --- Reparto de presupuesto ---
    const shareSum = plan.tasks.reduce((total, task) => total + task.budgetShare, 0);
    if (Math.abs(shareSum - 1) > BUDGET_SHARE_TOLERANCE) {
      ctx.addIssue({
        code: 'custom',
        path: ['tasks'],
        message:
          `la suma de budgetShare es ${shareSum.toFixed(3)} y debe ser 1.0 ` +
          `(±${BUDGET_SHARE_TOLERANCE}); reparte el presupuesto entre las tareas`,
      });
    }

    // --- Identificadores de criterios únicos dentro de cada tarea ---
    plan.tasks.forEach((task, taskIndex) => {
      const seen = new Set<string>();
      task.acceptanceCriteria.forEach((criterion, criterionIndex) => {
        if (seen.has(criterion.id)) {
          ctx.addIssue({
            code: 'custom',
            path: ['tasks', taskIndex, 'acceptanceCriteria', criterionIndex, 'id'],
            message: `el criterio "${criterion.id}" está repetido en esta tarea`,
          });
        }
        seen.add(criterion.id);
      });
    });

    // --- Al menos una raíz: sin ella nada puede empezar ---
    const hasRoot = nodes.some((node) => node.dependsOn.length === 0);
    if (!hasRoot && plan.tasks.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['tasks'],
        message:
          'ninguna tarea tiene dependsOn vacío: al menos una debe poder arrancar de inmediato',
      });
    }
  });

export type ProjectPlan = z.infer<typeof ProjectPlanSchema>;

/**
 * Variante SIN refinements cruzadas.
 *
 * Se usa como esquema de último recurso: si tras agotar las reparaciones el modelo sigue
 * sin producir un grafo válido, se acepta la forma básica y el planificador repara el grafo
 * de forma determinista (`pruneInvalidReferences` + `breakCycles`), dejando constancia en
 * `planner_metadata`. La regla 1 del proyecto (100% autónomo) impide abortar y esperar a
 * una persona.
 */
export const ProjectPlanShapeSchema = z.strictObject({
  title: z.string().min(5).max(200),
  summary: z.string().min(30).max(1200),
  tasks: z.array(PlanTaskSchema).min(MIN_TASKS).max(MAX_TASKS),
});

export type ProjectPlanShape = z.infer<typeof ProjectPlanShapeSchema>;
