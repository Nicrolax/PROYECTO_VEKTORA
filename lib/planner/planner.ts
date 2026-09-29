/**
 * VEKTORA · FASE 3 — ProjectPlanner.
 *
 * Objetivo en lenguaje natural  ->  DAG persistido en projects / project_tasks /
 * task_dependencies, sin intervención humana en ningún punto.
 *
 * Defensa en profundidad del grafo, en cuatro capas:
 *   1. El prompt explica la semántica de `dependsOn` y la aciclicidad.
 *   2. Las refinements de Zod detectan ciclos y referencias inválidas, y el bucle de
 *      auto-reparación de la FASE 2 hace que el propio modelo lo corrija.
 *   3. Si el modelo no lo logra, se acepta la forma básica del plan y se repara el grafo de
 *      forma DETERMINISTA (`pruneInvalidReferences` + `breakCycles`), quedando la corrección
 *      registrada en `projects.planner_metadata`.
 *   4. El trigger `prevent_dag_cycles` de la base es la última red: si salta (SQLSTATE
 *      23514) se rompe el ciclo y se reintenta una vez.
 *
 * Abortar y esperar a una persona no es una opción: lo prohíbe la regla 1 del proyecto.
 */

import type { AiClient } from '@/lib/ai/ai-client';
import { getAiClient } from '@/lib/ai/ai-client';
import { AiExhaustedError, errorMessage, isAiError } from '@/lib/ai/errors';
import { EmbeddingService, getEmbeddingService, toPgVector } from '@/lib/ai/embeddings';
import {
  breakCycles,
  computeDepths,
  describeDag,
  findCycles,
  formatCycle,
  pruneInvalidReferences,
  rootCodes,
  toEdges,
  topologicalSort,
  type BrokenEdge,
  type DagNode,
  type DagStats,
} from './dag';
import { allocateBudget } from './budget';
import {
  PLANNER_SYSTEM_PROMPT,
  renderGraphHintPrompt,
  renderPlannerPrompt,
  type SkillCatalogEntry,
} from './prompts';
import {
  PlannerRepositoryError,
  type PersistableEdge,
  type PersistableTask,
  type PlannerRepository,
  type ProjectRecord,
  type TaskEmbedding,
} from './repository';
import {
  ProjectPlanSchema,
  ProjectPlanShapeSchema,
  SKILL_SLUG_RE,
  type PlanTask,
  type ProjectPlanShape,
} from './schemas';

export interface PlanProjectInput {
  /** Proyecto existente a (re)planificar. Excluyente con `create`. */
  projectId?: string;
  /** Alta y planificación en un solo paso. */
  create?: {
    ownerId: string;
    objective: string;
    title?: string;
    budgetTotal?: number | null;
    currency?: string;
    deadline?: string | null;
    visibility?: 'private' | 'public';
  };
  constraints?: readonly string[];
  /** Vectoriza las tareas para el matching de la FASE 4. Por defecto sí. */
  embedTasks?: boolean;
  signal?: AbortSignal;
}

/** Corrección automática aplicada por el planificador, para la traza de auditoría. */
export interface PlannerCorrection {
  kind: 'pruned_reference' | 'broken_cycle' | 'schema_fallback' | 'dag_trigger_retry';
  detail: string;
}

export interface PlanProjectResult {
  project: ProjectRecord;
  taskCount: number;
  edgeCount: number;
  taskIds: Record<string, string>;
  stats: DagStats;
  /** Vacío cuando el modelo produjo un DAG válido por sí solo. */
  corrections: PlannerCorrection[];
  newSkills: string[];
  embeddedTasks: number;
  ai: {
    provider: string;
    model: string;
    runId: string | null;
    attempts: number;
    repairs: number;
    strictSchema: boolean;
  };
}

export interface ProjectPlannerOptions {
  repository: PlannerRepository;
  ai?: AiClient;
  embeddings?: EmbeddingService | null;
}

export class PlannerError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'PlannerError';
  }
}

export class ProjectPlanner {
  private readonly repository: PlannerRepository;
  private readonly ai: AiClient;
  private readonly embeddings: EmbeddingService | null;

  constructor(options: ProjectPlannerOptions) {
    this.repository = options.repository;
    this.ai = options.ai ?? getAiClient();
    this.embeddings =
      options.embeddings !== undefined ? options.embeddings : getEmbeddingService();
  }

  async planProject(input: PlanProjectInput): Promise<PlanProjectResult> {
    const corrections: PlannerCorrection[] = [];
    const project = await this.resolveProject(input);
    const skills = await this.repository.fetchSkillCatalog();

    // --- 1. Generación del plan -------------------------------------------------------
    const generated = await this.generatePlan(project, skills, input, corrections);
    const plan = generated.plan;

    // --- 2. Reparación determinista del grafo ------------------------------------------
    let nodes: DagNode[] = plan.tasks.map((task) => ({
      code: task.code,
      dependsOn: task.dependsOn,
      weight: task.estimatedHours,
    }));

    const pruned = pruneInvalidReferences(nodes);
    if (pruned.removed.length > 0) {
      nodes = pruned.nodes;
      for (const edge of pruned.removed) {
        corrections.push({
          kind: 'pruned_reference',
          detail: `se descartó la dependencia inválida ${edge.from} → ${edge.to}`,
        });
      }
    }

    const broken = breakCycles(nodes);
    if (broken.removed.length > 0) {
      nodes = broken.nodes;
      for (const edge of broken.removed) {
        corrections.push({
          kind: 'broken_cycle',
          detail: `se rompió el ciclo ${formatCycle(edge.cycle)} eliminando ${edge.from} → ${edge.to}`,
        });
      }
    }

    // --- 3. Derivación de columnas ----------------------------------------------------
    const persistable = this.toPersistableTasks(plan.tasks, nodes, project.budgetTotal);
    const edges: PersistableEdge[] = toEdges(nodes).map((edge) => ({
      task_code: edge.from,
      depends_on_code: edge.to,
    }));
    const stats = describeDag(nodes);

    // --- 4. Catálogo de skills --------------------------------------------------------
    const newSkills = this.findUnknownSkills(plan.tasks, skills);
    if (newSkills.length > 0) {
      try {
        await this.repository.registerSkills(newSkills);
      } catch (error) {
        // Que no se amplíe el catálogo no invalida el plan: `required_skills` es text[].
        console.warn(`[vektora/planner] registrar skills: ${errorMessage(error)}`);
      }
    }

    // --- 5. Persistencia transaccional ------------------------------------------------
    const metadata = {
      generated_at: new Date().toISOString(),
      planner_version: 3,
      // `apply_project_plan` sustituye con esto el título provisional que se puso al crear
      // el proyecto (los primeros 120 caracteres del objetivo).
      title: plan.title,
      summary: plan.summary,
      ai: generated.meta,
      dag: {
        task_count: stats.taskCount,
        edge_count: stats.edgeCount,
        depth: stats.depth,
        roots: stats.roots,
        leaves: stats.leaves,
        critical_path: stats.criticalPath.path,
        critical_path_hours: stats.criticalPath.totalWeight,
        levels: stats.levels,
      },
      corrections,
      new_skills: newSkills,
    };

    const applied = await this.applyWithDagRetry(
      project.id,
      persistable,
      edges,
      metadata,
      nodes,
      corrections,
    );

    // --- 6. Embeddings de tareas (FASE 4) ---------------------------------------------
    const embeddedTasks =
      input.embedTasks === false
        ? 0
        : await this.embedTasks(plan.tasks, applied.taskIds, project.id);

    return {
      // El título persistido es el que propuso el planificador, no el provisional con el
      // que se creó el proyecto: `apply_project_plan` ya lo sustituyó en la base.
      project: { ...project, title: plan.title },
      taskCount: applied.taskCount,
      edgeCount: applied.edgeCount,
      taskIds: applied.taskIds,
      stats,
      corrections,
      newSkills,
      embeddedTasks,
      ai: generated.meta,
    };
  }

  // -----------------------------------------------------------------------------------

  private async resolveProject(input: PlanProjectInput): Promise<ProjectRecord> {
    if (input.projectId !== undefined) {
      const project = await this.repository.loadProject(input.projectId);
      if (project === null) {
        throw new PlannerError(
          `VEKTORA/PLANNER: el proyecto ${input.projectId} no existe o no es accesible`,
        );
      }
      return project;
    }

    if (input.create === undefined) {
      throw new PlannerError(
        'VEKTORA/PLANNER: hay que indicar projectId o create para planificar',
      );
    }

    const objective = input.create.objective.trim();
    if (objective.length < 10) {
      throw new PlannerError(
        'VEKTORA/PLANNER: el objetivo es demasiado corto para descomponerlo',
      );
    }

    return this.repository.createProject({
      ownerId: input.create.ownerId,
      // Título provisional; se reemplaza por el que proponga el planificador.
      title: input.create.title ?? objective.slice(0, 120),
      objective,
      budgetTotal: input.create.budgetTotal ?? null,
      ...(input.create.currency === undefined ? {} : { currency: input.create.currency }),
      deadline: input.create.deadline ?? null,
      ...(input.create.visibility === undefined ? {} : { visibility: input.create.visibility }),
    });
  }

  /**
   * Pide el plan con el esquema estricto (refinements de DAG incluidas). Si se agotan los
   * proveedores y las reparaciones, reintenta con el esquema sin refinements cruzadas para
   * poder repararlo determinísticamente después.
   */
  private async generatePlan(
    project: ProjectRecord,
    skills: readonly SkillCatalogEntry[],
    input: PlanProjectInput,
    corrections: PlannerCorrection[],
  ): Promise<{
    plan: ProjectPlanShape;
    meta: PlanProjectResult['ai'];
  }> {
    const prompt = renderPlannerPrompt({
      objective: project.objective,
      skills,
      budgetTotal: project.budgetTotal,
      currency: project.currency,
      deadline: project.deadline,
      ...(input.constraints === undefined ? {} : { constraints: input.constraints }),
    });

    const base = {
      operation: 'project_planning' as const,
      system: PLANNER_SYSTEM_PROMPT,
      prompt,
      context: { projectId: project.id, userId: project.ownerId },
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    };

    try {
      const strict = await this.ai.generateStructured({
        ...base,
        schema: ProjectPlanSchema,
        schemaName: 'ProjectPlan',
      });
      return {
        plan: strict.data,
        meta: {
          provider: strict.provider,
          model: strict.model,
          runId: strict.runId,
          attempts: strict.attempts,
          repairs: strict.repairs,
          strictSchema: true,
        },
      };
    } catch (error) {
      if (!(error instanceof AiExhaustedError)) throw error;

      // Se rescatan los problemas de grafo detectados para reforzar el siguiente prompt.
      const graphProblems = error.failures
        .filter((failure) => failure.code === 'invalid_output')
        .map((failure) => failure.message)
        .filter((message) => /ciclo|dependsOn|código/i.test(message))
        .slice(0, 6);

      const hint = renderGraphHintPrompt(graphProblems);
      const relaxed = await this.ai.generateStructured({
        ...base,
        schema: ProjectPlanShapeSchema,
        schemaName: 'ProjectPlanShape',
        prompt: hint === '' ? prompt : `${prompt}\n\n${hint}`,
      });

      corrections.push({
        kind: 'schema_fallback',
        detail:
          'el modelo no produjo un DAG válido tras las reparaciones; se aceptó la forma ' +
          'básica del plan y el grafo se corrigió de forma determinista',
      });

      return {
        plan: relaxed.data,
        meta: {
          provider: relaxed.provider,
          model: relaxed.model,
          runId: relaxed.runId,
          attempts: relaxed.attempts,
          repairs: relaxed.repairs,
          strictSchema: false,
        },
      };
    }
  }

  /** Convierte el plan validado en filas de `project_tasks`. */
  private toPersistableTasks(
    tasks: readonly PlanTask[],
    nodes: readonly DagNode[],
    budgetTotal: number | null,
  ): PersistableTask[] {
    const { order } = topologicalSort(nodes);
    const depths = computeDepths(nodes);
    const roots = new Set(rootCodes(nodes));
    const dependsByCode = new Map(nodes.map((node) => [node.code, node.dependsOn]));

    // `order_index` sigue el orden topológico; las tareas en ciclo irreparable van al final.
    const orderIndex = new Map<string, number>();
    order.forEach((code, index) => orderIndex.set(code, index + 1));
    let tail = order.length;
    for (const task of tasks) {
      if (!orderIndex.has(task.code)) {
        tail += 1;
        orderIndex.set(task.code, tail);
      }
    }

    const allocations = allocateBudget(
      tasks.map((task) => ({ code: task.code, share: task.budgetShare })),
      budgetTotal,
    );
    const budgetByCode = new Map(allocations.map((entry) => [entry.code, entry.budget]));

    return tasks.map((task) => ({
      code: task.code,
      title: task.title,
      description: task.description,
      acceptance_criteria: task.acceptanceCriteria,
      required_skills: normalizeSkillSlugs(task.requiredSkills),
      estimated_hours: task.estimatedHours,
      budget: budgetByCode.get(task.code) ?? null,
      priority: task.priority,
      order_index: orderIndex.get(task.code) ?? 0,
      depth: depths.get(task.code) ?? 0,
      // Solo las raíces pueden arrancar. `refresh_task_readiness` mantiene esto después.
      status: roots.has(task.code) && (dependsByCode.get(task.code)?.length ?? 0) === 0
        ? 'ready'
        : 'blocked',
    }));
  }

  private findUnknownSkills(
    tasks: readonly PlanTask[],
    catalog: readonly SkillCatalogEntry[],
  ): string[] {
    const known = new Set(catalog.map((entry) => entry.slug.toLowerCase()));
    const unknown = new Set<string>();
    for (const task of tasks) {
      for (const slug of normalizeSkillSlugs(task.requiredSkills)) {
        if (!known.has(slug)) unknown.add(slug);
      }
    }
    return [...unknown].sort();
  }

  /**
   * Persiste el plan. Si el trigger `prevent_dag_cycles` rechaza la transacción, significa
   * que el análisis en memoria y la base discrepan: se rompen los ciclos que se encuentren
   * y se reintenta UNA vez. Un segundo rechazo se propaga, porque reintentar en bucle
   * escondería un error real.
   */
  private async applyWithDagRetry(
    projectId: string,
    tasks: readonly PersistableTask[],
    edges: readonly PersistableEdge[],
    metadata: Record<string, unknown>,
    nodes: readonly DagNode[],
    corrections: PlannerCorrection[],
  ): Promise<{ taskCount: number; edgeCount: number; taskIds: Record<string, string> }> {
    try {
      return await this.repository.applyPlan(projectId, tasks, edges, metadata);
    } catch (error) {
      const isDagViolation =
        error instanceof PlannerRepositoryError && error.isDagViolation;
      if (!isDagViolation) throw error;

      const repaired = breakCycles(nodes);
      const removed: BrokenEdge[] = repaired.removed;
      const detail =
        removed.length > 0
          ? removed
              .map((edge) => `${formatCycle(edge.cycle)} (quitando ${edge.from} → ${edge.to})`)
              .join('; ')
          : 'el trigger rechazó el grafo pero no se encontró ciclo en memoria';

      corrections.push({ kind: 'dag_trigger_retry', detail });

      const retryEdges: PersistableEdge[] = toEdges(repaired.nodes).map((edge) => ({
        task_code: edge.from,
        depends_on_code: edge.to,
      }));

      return this.repository.applyPlan(projectId, tasks, retryEdges, {
        ...metadata,
        corrections,
      });
    }
  }

  /** Vectoriza cada tarea para la búsqueda semántica de la FASE 4. */
  private async embedTasks(
    tasks: readonly PlanTask[],
    taskIds: Record<string, string>,
    projectId: string,
  ): Promise<number> {
    const embeddings = this.embeddings;
    if (embeddings === null || !embeddings.isAvailable()) return 0;

    const targets = tasks
      .map((task) => ({ task, id: taskIds[task.code] }))
      .filter((entry): entry is { task: PlanTask; id: string } => typeof entry.id === 'string');

    if (targets.length === 0) return 0;

    try {
      const response = await embeddings.embedTexts({
        texts: targets.map((entry) => renderTaskForEmbedding(entry.task)),
        taskType: 'RETRIEVAL_DOCUMENT',
        context: { projectId },
      });

      const entries: TaskEmbedding[] = [];
      response.vectors.forEach((vector, index) => {
        const target = targets[index];
        if (target === undefined) return;
        entries.push({
          taskId: target.id,
          vector: toPgVector(vector, response.dimensions),
          model: response.model,
        });
      });

      return this.repository.saveTaskEmbeddings(entries);
    } catch (error) {
      // El plan ya está guardado y es válido; sin embeddings el matching de la FASE 4
      // caerá al ranking determinista. Se degrada, no se falla.
      const detail = isAiError(error) ? error.code : errorMessage(error);
      console.warn(`[vektora/planner] embeddings de tareas omitidos: ${detail}`);
      return 0;
    }
  }
}

/**
 * Texto que representa la tarea en el espacio vectorial. Se incluyen skills y criterios
 * porque son justamente lo que hay que emparejar con el perfil del proveedor.
 */
export function renderTaskForEmbedding(task: PlanTask): string {
  return [
    task.title,
    task.description,
    `Skills requeridas: ${task.requiredSkills.join(', ')}`,
    `Criterios de aceptación: ${task.acceptanceCriteria
      .map((criterion) => criterion.criterion)
      .join(' | ')}`,
  ].join('\n');
}

/** Deduplica, normaliza a minúsculas y descarta slugs con formato inválido. */
export function normalizeSkillSlugs(slugs: readonly string[]): string[] {
  const out = new Set<string>();
  for (const raw of slugs) {
    const slug = raw
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-]/g, '')
      .replace(/-{2,}/g, '-')
      .replace(/^-|-$/g, '');
    if (slug !== '' && SKILL_SLUG_RE.test(slug)) out.add(slug);
  }
  return [...out].sort();
}

/** Diagnóstico: ciclos que quedan en un conjunto de nodos ya reparado. */
export function residualCycles(nodes: readonly DagNode[]): string[] {
  return findCycles(nodes).map(formatCycle);
}
