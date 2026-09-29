/**
 * VEKTORA · FASE 3 — Acceso a datos del planificador.
 *
 * El planificador habla con esta interfaz, nunca con Supabase directamente: así su lógica
 * (que es la parte con reglas de negocio) se prueba sin base de datos, y la persistencia
 * real queda concentrada en un único sitio auditable.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { toNumber } from '@/lib/supabase/types';
import type { ApplyProjectPlanResult, ProjectRow } from '@/lib/supabase/types';
import type { SkillCatalogEntry } from './prompts';

export interface ProjectRecord {
  id: string;
  ownerId: string;
  title: string;
  objective: string;
  status: string;
  visibility: string;
  currency: string;
  budgetTotal: number | null;
  deadline: string | null;
}

export interface CreateProjectInput {
  ownerId: string;
  title: string;
  objective: string;
  budgetTotal?: number | null;
  currency?: string;
  deadline?: string | null;
  visibility?: 'private' | 'public';
  acceptancePolicy?: Record<string, unknown>;
}

/** Fila de `project_tasks` tal como la consume `apply_project_plan`. */
export interface PersistableTask {
  code: string;
  title: string;
  description: string;
  acceptance_criteria: unknown[];
  required_skills: string[];
  estimated_hours: number;
  budget: number | null;
  priority: number;
  order_index: number;
  depth: number;
  status: 'blocked' | 'ready';
}

/** Arista para `task_dependencies`: `task_code` depende de `depends_on_code`. */
export interface PersistableEdge {
  task_code: string;
  depends_on_code: string;
}

export interface ApplyPlanResult {
  projectId: string;
  taskCount: number;
  edgeCount: number;
  /** code -> uuid de `project_tasks`, necesario para escribir los embeddings. */
  taskIds: Record<string, string>;
}

export interface TaskEmbedding {
  taskId: string;
  vector: string;
  model: string;
}

export interface PlannerRepository {
  fetchSkillCatalog(): Promise<SkillCatalogEntry[]>;
  registerSkills(slugs: readonly string[]): Promise<number>;
  loadProject(projectId: string): Promise<ProjectRecord | null>;
  createProject(input: CreateProjectInput): Promise<ProjectRecord>;
  applyPlan(
    projectId: string,
    tasks: readonly PersistableTask[],
    edges: readonly PersistableEdge[],
    metadata: Record<string, unknown>,
  ): Promise<ApplyPlanResult>;
  saveTaskEmbeddings(entries: readonly TaskEmbedding[]): Promise<number>;
}

export class PlannerRepositoryError extends Error {
  readonly code: string | undefined;
  readonly details: unknown;

  constructor(message: string, code?: string, details?: unknown) {
    super(message);
    this.name = 'PlannerRepositoryError';
    this.code = code;
    this.details = details;
  }

  /** `true` cuando el fallo viene del trigger `prevent_dag_cycles` de la FASE 1. */
  get isDagViolation(): boolean {
    return this.code === '23514';
  }
}

interface PostgrestErrorLike {
  message: string;
  code?: string;
  details?: unknown;
  hint?: unknown;
}

function fail(action: string, error: PostgrestErrorLike): never {
  throw new PlannerRepositoryError(
    `VEKTORA/PLANNER: ${action} falló -> ${error.message}`,
    error.code,
    error.details ?? error.hint,
  );
}

const PROJECT_COLUMNS =
  'id, owner_id, title, objective, status, visibility, currency, budget_total, deadline';

/** Subconjunto de `ProjectRow` que pide `PROJECT_COLUMNS`. */
type ProjectSelection = Pick<
  ProjectRow,
  | 'id'
  | 'owner_id'
  | 'title'
  | 'objective'
  | 'status'
  | 'visibility'
  | 'currency'
  | 'budget_total'
  | 'deadline'
>;

function toProjectRecord(row: ProjectSelection): ProjectRecord {
  return {
    id: row.id,
    ownerId: row.owner_id,
    title: row.title,
    objective: row.objective,
    status: row.status,
    visibility: row.visibility,
    currency: row.currency,
    // `numeric` de PostgreSQL llega como string por PostgREST: se normaliza aquí y no en
    // el planificador, que no debe conocer esa peculiaridad.
    budgetTotal: toNumber(row.budget_total),
    deadline: row.deadline,
  };
}

export class SupabasePlannerRepository implements PlannerRepository {
  constructor(private readonly client: SupabaseClient) {}

  async fetchSkillCatalog(): Promise<SkillCatalogEntry[]> {
    const { data, error } = await this.client
      .from('skills')
      .select('slug, name, category')
      .eq('is_active', true)
      .order('category', { ascending: true })
      .order('slug', { ascending: true });

    if (error !== null) fail('leer el catálogo de skills', error);
    return (data ?? []) as SkillCatalogEntry[];
  }

  async registerSkills(slugs: readonly string[]): Promise<number> {
    if (slugs.length === 0) return 0;
    const { data, error } = await this.client.rpc('register_skills', { p_slugs: [...slugs] });
    if (error !== null) fail('registrar skills nuevas', error);
    return typeof data === 'number' ? data : 0;
  }

  async loadProject(projectId: string): Promise<ProjectRecord | null> {
    const { data, error } = await this.client
      .from('projects')
      .select(PROJECT_COLUMNS)
      .eq('id', projectId)
      .maybeSingle();

    if (error !== null) fail('cargar el proyecto', error);
    return data === null ? null : toProjectRecord(data as ProjectSelection);
  }

  async createProject(input: CreateProjectInput): Promise<ProjectRecord> {
    const { data, error } = await this.client
      .from('projects')
      .insert({
        owner_id: input.ownerId,
        title: input.title,
        objective: input.objective,
        budget_total: input.budgetTotal ?? null,
        currency: input.currency ?? 'USD',
        deadline: input.deadline ?? null,
        visibility: input.visibility ?? 'private',
        acceptance_policy: input.acceptancePolicy ?? {},
        status: 'planning',
      })
      .select(PROJECT_COLUMNS)
      .single();

    if (error !== null) fail('crear el proyecto', error);
    return toProjectRecord(data as ProjectSelection);
  }

  async applyPlan(
    projectId: string,
    tasks: readonly PersistableTask[],
    edges: readonly PersistableEdge[],
    metadata: Record<string, unknown>,
  ): Promise<ApplyPlanResult> {
    const { data, error } = await this.client.rpc('apply_project_plan', {
      p_project_id: projectId,
      p_tasks: tasks,
      p_dependencies: edges,
      p_planner_metadata: metadata,
    });

    if (error !== null) fail('aplicar el plan', error);

    const payload = (data ?? {}) as Partial<ApplyProjectPlanResult>;
    return {
      projectId,
      taskCount: payload.task_count ?? tasks.length,
      edgeCount: payload.edge_count ?? edges.length,
      taskIds: payload.task_ids ?? {},
    };
  }

  async saveTaskEmbeddings(entries: readonly TaskEmbedding[]): Promise<number> {
    let saved = 0;
    for (const entry of entries) {
      const { error } = await this.client
        .from('project_tasks')
        .update({
          embedding: entry.vector,
          embedding_model: entry.model,
          embedding_updated_at: new Date().toISOString(),
        })
        .eq('id', entry.taskId);

      // Un embedding que no se guarda degrada el matching de la FASE 4, pero no invalida
      // el plan: se cuenta y se reporta en el resultado en lugar de abortar.
      if (error === null) saved += 1;
      else console.warn(`[vektora/planner] embedding de ${entry.taskId}: ${error.message}`);
    }
    return saved;
  }
}
