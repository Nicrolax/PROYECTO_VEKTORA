/**
 * VEKTORA — Contratos de fila de `db/schema.sql`, tal como los devuelve PostgREST.
 *
 * Reconstruidos el 2026-09-14 desde el volcado de catálogos de la base desplegada, no
 * desde la documentación. Si una columna no está aquí, no está en la base.
 *
 * Dos peculiaridades de PostgREST que estos tipos hacen explícitas en vez de dejar que
 * exploten en tiempo de ejecución:
 *   · `numeric` llega como STRING, no como number (por eso `PgNumeric`). Quien lea una de
 *     esas columnas debe normalizarla con `toNumber`.
 *   · `vector(1536)` se escribe y se lee como el literal `'[0.1,0.2,…]'`, no como array.
 *
 * Los literales replican los ENUM del esquema: si cambian allí, cambian aquí.
 */

// ---------------------------------------------------------------------------------------
// ENUM del dominio (14)
// ---------------------------------------------------------------------------------------

export type UserRole = 'client' | 'provider' | 'both' | 'admin';
export type AccountStatus = 'active' | 'suspended' | 'banned' | 'deleted';
export type ActorType = 'user' | 'ai_agent' | 'system' | 'service';

export type ProjectStatus =
  | 'draft'
  | 'planning'
  | 'planned'
  | 'active'
  | 'paused'
  | 'completed'
  | 'cancelled'
  | 'failed';
export type ProjectVisibility = 'private' | 'public';

export type TaskStatus =
  | 'blocked'
  | 'ready'
  | 'open'
  | 'matching'
  | 'assigned'
  | 'in_progress'
  | 'submitted'
  | 'in_review'
  | 'revision_requested'
  | 'approved'
  | 'cancelled'
  | 'failed';

export type DependencyType =
  | 'finish_to_start'
  | 'start_to_start'
  | 'finish_to_finish'
  | 'start_to_finish';

export type ApplicationStatus =
  | 'pending'
  | 'shortlisted'
  | 'accepted'
  | 'rejected'
  | 'withdrawn'
  | 'expired';

export type QaStatus =
  | 'pending'
  | 'running'
  | 'approved'
  | 'rejected'
  | 'revision_requested'
  | 'error';

export type ReviewSource = 'human' | 'ai_judge' | 'system';

export type ReputationEventType =
  | 'onboarding_bonus'
  | 'deliverable_approved'
  | 'deliverable_rejected'
  | 'task_completed'
  | 'task_failed'
  | 'review_received'
  | 'deadline_met'
  | 'deadline_missed'
  | 'evidence_verified'
  | 'evidence_disputed'
  | 'manual_adjustment';

/** Los tres de IA viven en `lib/ai/types.ts`, que es donde los consume la telemetría. */
export type { AiOperation, AiProviderId, AiRunStatus } from '@/lib/ai/types';

// ---------------------------------------------------------------------------------------
// Tipos de columna
// ---------------------------------------------------------------------------------------

/** Literal de pgvector: `[0.0123,-0.44,…]`. Lo produce `toPgVector`. */
export type PgVector = string;

/** `numeric` de PostgreSQL: PostgREST lo serializa como string. */
export type PgNumeric = number | string;

// ---------------------------------------------------------------------------------------
// Filas
// ---------------------------------------------------------------------------------------

/**
 * Identidad y autorización. El nombre y los datos de presentación NO están aquí: viven en
 * `profiles`. `email` es nullable porque una cuenta de agente puede no tener correo.
 */
export interface UserRow {
  id: string;
  email: string | null;
  role: UserRole;
  status: AccountStatus;
  is_agent: boolean;
  last_seen_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProfileRow {
  id: string;
  user_id: string;
  full_name: string | null;
  display_name: string | null;
  avatar_url: string | null;
  bio: string | null;
  country_code: string | null;
  timezone: string;
  locale: string;
  website_url: string | null;
  links: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

/**
 * `reputation_score`, `tasks_completed`, `tasks_failed` y `avg_rating` son PROYECCIONES
 * materializadas por trigger desde `reputation_events` y `reviews`: no se escriben a mano.
 */
export interface ProviderProfileRow {
  id: string;
  user_id: string;
  headline: string | null;
  summary: string | null;
  seniority: string | null;
  hourly_rate_usd: PgNumeric | null;
  min_task_budget_usd: PgNumeric | null;
  availability_hours_week: number | null;
  languages: string[];
  timezone: string | null;
  is_active: boolean;
  accepts_auto_assign: boolean;
  reputation_score: PgNumeric;
  tasks_completed: number;
  tasks_failed: number;
  avg_rating: PgNumeric | null;
  on_time_rate: PgNumeric | null;
  embedding: PgVector | null;
  embedding_model: string | null;
  embedding_updated_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SkillRow {
  id: string;
  slug: string;
  name: string;
  category: string | null;
  description: string | null;
  is_active: boolean;
  created_at: string;
}

export interface ProviderSkillRow {
  id: string;
  provider_profile_id: string;
  skill_id: string;
  level: number;
  years_experience: PgNumeric | null;
  is_verified: boolean;
  created_at: string;
}

export interface ProjectRow {
  id: string;
  owner_id: string;
  title: string;
  objective: string;
  description: string | null;
  status: ProjectStatus;
  visibility: ProjectVisibility;
  currency: string;
  budget_total: PgNumeric | null;
  deadline: string | null;
  acceptance_policy: Record<string, unknown>;
  /** Traza del ProjectPlanner: versión, resumen, estadísticas del DAG y correcciones. */
  planner_metadata: Record<string, unknown>;
  dag_generated_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProjectTaskRow {
  id: string;
  project_id: string;
  parent_task_id: string | null;
  code: string;
  title: string;
  description: string | null;
  acceptance_criteria: unknown[];
  required_skills: string[];
  status: TaskStatus;
  priority: number;
  order_index: number;
  depth: number;
  estimated_hours: PgNumeric | null;
  budget: PgNumeric | null;
  assignee_id: string | null;
  assigned_at: string | null;
  due_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  embedding: PgVector | null;
  embedding_model: string | null;
  embedding_updated_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Arista del DAG: `task_id` no puede empezar hasta que `depends_on_task_id` se satisfaga.
 * NO tiene `project_id`: la pertenencia se deriva de `project_tasks` y el trigger
 * `prevent_dag_cycles` comprueba que ambos extremos sean del mismo proyecto.
 */
export interface TaskDependencyRow {
  id: string;
  task_id: string;
  depends_on_task_id: string;
  dependency_type: DependencyType;
  lag_hours: PgNumeric;
  created_by: ActorType;
  created_at: string;
}

export interface TaskApplicationRow {
  id: string;
  task_id: string;
  provider_id: string;
  cover_letter: string | null;
  proposed_price: PgNumeric | null;
  proposed_hours: PgNumeric | null;
  status: ApplicationStatus;
  /** Desglose del matching híbrido de la FASE 4: sin él una asignación no es auditable. */
  vector_score: PgNumeric | null;
  skill_score: PgNumeric | null;
  reputation_score: PgNumeric | null;
  match_score: PgNumeric | null;
  match_explanation: Record<string, unknown>;
  is_auto_generated: boolean;
  decided_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DeliverableRow {
  id: string;
  task_id: string;
  provider_id: string;
  version: number;
  summary: string | null;
  content: string | null;
  artifacts: unknown[];
  /** Lo que evalúa el AI Judge de la FASE 5 contra los criterios de aceptación. */
  evidence: Record<string, unknown>;
  qa_status: QaStatus;
  qa_score: PgNumeric | null;
  qa_feedback: Record<string, unknown>;
  qa_criteria_results: unknown[];
  qa_run_id: string | null;
  qa_evaluated_at: string | null;
  submitted_at: string;
  created_at: string;
  updated_at: string;
}

export interface ReviewRow {
  id: string;
  task_id: string;
  deliverable_id: string | null;
  /** `null` cuando la reseña la emitió el AI Judge. */
  reviewer_id: string | null;
  reviewee_id: string;
  source: ReviewSource;
  rating: PgNumeric;
  quality_score: PgNumeric | null;
  communication_score: PgNumeric | null;
  timeliness_score: PgNumeric | null;
  comment: string | null;
  is_public: boolean;
  created_at: string;
  updated_at: string;
}

/** Append-only: la reputación mostrada debe poder reconstruirse sumando `delta * weight`. */
export interface ReputationEventRow {
  id: string;
  user_id: string;
  event_type: ReputationEventType;
  delta: PgNumeric;
  weight: PgNumeric;
  reason: string | null;
  task_id: string | null;
  deliverable_id: string | null;
  review_id: string | null;
  actor_type: ActorType;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface AiRunRow {
  id: string;
  operation: string;
  provider: string;
  model: string;
  status: string;
  attempt: number;
  fell_back_from: string | null;
  parent_run_id: string | null;
  user_id: string | null;
  project_id: string | null;
  task_id: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  latency_ms: number | null;
  cost_usd: PgNumeric;
  request_payload: Record<string, unknown>;
  response_payload: Record<string, unknown>;
  zod_errors: unknown[] | null;
  error_message: string | null;
  started_at: string;
  finished_at: string | null;
}

/** Append-only. */
export interface AuditLogRow {
  id: string;
  actor_id: string | null;
  actor_type: ActorType;
  action: string;
  entity_type: string;
  entity_id: string | null;
  project_id: string | null;
  changes: Record<string, unknown>;
  metadata: Record<string, unknown>;
  ip_address: string | null;
  user_agent: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------------------
// Contratos de las RPC
// ---------------------------------------------------------------------------------------

/** Resultado de `apply_project_plan`. */
export interface ApplyProjectPlanResult {
  project_id: string;
  /** Tareas que quedan en el proyecto tras aplicar el plan. */
  task_count: number;
  /** Tareas que traía el plan (puede diferir: no se borran las asignadas o entregadas). */
  inserted_tasks: number;
  edge_count: number;
  /** `code` de la tarea -> uuid de `project_tasks`. */
  task_ids: Record<string, string>;
}

/** Resultado de `project_dag`, que es una FUNCIÓN jsonb y no una vista. */
export interface ProjectDagResult {
  project_id: string;
  tasks: Array<{
    id: string;
    code: string;
    title: string;
    status: TaskStatus;
    priority: number;
    depth: number;
    order_index: number;
    estimated_hours: PgNumeric | null;
    budget: PgNumeric | null;
    required_skills: string[];
    assignee_id: string | null;
    has_embedding: boolean;
  }>;
  edges: Array<{
    task_code: string;
    depends_on_code: string;
    dependency_type: DependencyType;
  }>;
}

// ---------------------------------------------------------------------------------------

/**
 * Normaliza un `numeric` de PostgREST. Devuelve `null` si el valor es nulo o no numérico:
 * un NaN silencioso propagado a un cálculo de presupuesto es peor que un null explícito.
 */
export function toNumber(value: PgNumeric | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
