/**
 * VEKTORA · FASE 4 — Acceso a datos del motor de matching.
 *
 * Mismo patrón que planner y providers: el dominio habla con esta interfaz, así el ranking
 * —que es donde el motor puede equivocarse— se prueba sin base de datos.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { toNumber, type PgNumeric } from '@/lib/supabase/types';
import type { MatchCandidate, ScoredCandidate } from './scoring';

export interface MatchTaskRecord {
  id: string;
  projectId: string;
  ownerId: string;
  code: string;
  title: string;
  description: string | null;
  status: string;
  requiredSkills: string[];
  acceptanceCriteria: unknown[];
  estimatedHours: number | null;
  budget: number | null;
  assigneeId: string | null;
  hasEmbedding: boolean;
  /** Veces que ya se buscó proveedor para esta tarea sin llegar a adjudicarla. */
  matchingRounds: number;
}

export interface ApplyMatchesResult {
  taskId: string;
  written: number;
  totalApplications: number;
}

export interface AcceptResult {
  taskId: string;
  applicationId: string;
  providerId: string;
}

export interface MatchingRepository {
  loadTask(taskId: string): Promise<MatchTaskRecord | null>;
  saveTaskEmbedding(taskId: string, vector: string, model: string): Promise<boolean>;
  fetchCandidates(params: {
    taskId: string;
    limit: number;
    requireAutoAssign: boolean;
  }): Promise<MatchCandidate[]>;
  applyMatches(taskId: string, matches: readonly ScoredCandidate[]): Promise<ApplyMatchesResult>;
  /** Suma una ronda de búsqueda sin adjudicación. Devuelve el total tras sumarla. */
  bumpMatchingRound(taskId: string): Promise<number>;
  findApplicationId(taskId: string, providerId: string): Promise<string | null>;
  acceptApplication(applicationId: string): Promise<AcceptResult>;
}

export class MatchingRepositoryError extends Error {
  readonly code: string | undefined;
  readonly details: unknown;

  constructor(message: string, code?: string, details?: unknown) {
    super(message);
    this.name = 'MatchingRepositoryError';
    this.code = code;
    this.details = details;
  }

  /** `true` cuando otra adjudicación ganó la carrera por la misma tarea. */
  get isAlreadyAssigned(): boolean {
    return this.code === '23505';
  }
}

interface PostgrestErrorLike {
  message: string;
  code?: string;
  details?: unknown;
  hint?: unknown;
}

function fail(action: string, error: PostgrestErrorLike): never {
  throw new MatchingRepositoryError(
    `VEKTORA/MATCH: ${action} falló -> ${error.message}`,
    error.code,
    error.details ?? error.hint,
  );
}

/** Fila cruda de `match_task_candidates`. PostgREST devuelve los numeric como string. */
interface CandidateRow {
  provider_profile_id: string;
  user_id: string;
  headline: string | null;
  seniority: string | null;
  hourly_rate_usd: PgNumeric | null;
  min_task_budget_usd: PgNumeric | null;
  availability_hours_week: number | null;
  reputation_score: PgNumeric;
  tasks_completed: number;
  tasks_failed: number;
  avg_rating: PgNumeric | null;
  on_time_rate: PgNumeric | null;
  accepts_auto_assign: boolean;
  vector_similarity: PgNumeric | null;
  skill_slugs: string[] | null;
  skill_levels: number[] | null;
}

function toCandidate(row: CandidateRow): MatchCandidate {
  const slugs = row.skill_slugs ?? [];
  const levels = row.skill_levels ?? [];
  return {
    providerProfileId: row.provider_profile_id,
    userId: row.user_id,
    headline: row.headline,
    seniority: row.seniority,
    hourlyRateUsd: toNumber(row.hourly_rate_usd),
    minTaskBudgetUsd: toNumber(row.min_task_budget_usd),
    availabilityHoursWeek: row.availability_hours_week,
    reputationScore: toNumber(row.reputation_score) ?? 0,
    tasksCompleted: row.tasks_completed ?? 0,
    tasksFailed: row.tasks_failed ?? 0,
    avgRating: toNumber(row.avg_rating),
    onTimeRate: toNumber(row.on_time_rate),
    acceptsAutoAssign: row.accepts_auto_assign,
    vectorSimilarity: toNumber(row.vector_similarity),
    skills: slugs.map((slug, index) => ({ slug, level: levels[index] ?? 3 })),
  };
}

const TASK_COLUMNS =
  'id, project_id, code, title, description, status, required_skills, acceptance_criteria, ' +
  'estimated_hours, budget, assignee_id, embedding, matching_rounds, ' +
  'projects!inner(owner_id)';

export class SupabaseMatchingRepository implements MatchingRepository {
  constructor(private readonly client: SupabaseClient) {}

  async loadTask(taskId: string): Promise<MatchTaskRecord | null> {
    const { data, error } = await this.client
      .from('project_tasks')
      .select(TASK_COLUMNS)
      .eq('id', taskId)
      .maybeSingle();

    if (error !== null) fail('cargar la tarea', error);
    if (data === null) return null;

    // Doble cast a propósito: con un `select` que lleva relación embebida
    // (`projects!inner(...)`), los tipos genéricos de supabase-js no saben inferir la
    // forma y colapsan a un error de cadena. La forma real se valida abajo, campo a campo.
    const row = data as unknown as Record<string, unknown>;
    const project = row['projects'];
    const owner = Array.isArray(project) ? project[0] : project;

    return {
      id: String(row['id']),
      projectId: String(row['project_id']),
      ownerId: String((owner as { owner_id?: unknown } | null)?.owner_id ?? ''),
      code: String(row['code']),
      title: String(row['title']),
      description: (row['description'] as string | null) ?? null,
      status: String(row['status']),
      requiredSkills: Array.isArray(row['required_skills'])
        ? (row['required_skills'] as string[])
        : [],
      acceptanceCriteria: Array.isArray(row['acceptance_criteria'])
        ? (row['acceptance_criteria'] as unknown[])
        : [],
      estimatedHours: toNumber(row['estimated_hours'] as PgNumeric | null),
      budget: toNumber(row['budget'] as PgNumeric | null),
      assigneeId: (row['assignee_id'] as string | null) ?? null,
      // No se trae el vector entero: son 1536 números que no se usan del lado del cliente.
      hasEmbedding: row['embedding'] !== null && row['embedding'] !== undefined,
      matchingRounds: Number(row['matching_rounds'] ?? 0),
    };
  }

  async saveTaskEmbedding(taskId: string, vector: string, model: string): Promise<boolean> {
    const { error } = await this.client
      .from('project_tasks')
      .update({
        embedding: vector,
        embedding_model: model,
        embedding_updated_at: new Date().toISOString(),
      })
      .eq('id', taskId);

    if (error !== null) {
      console.warn(`[vektora/match] no se pudo vectorizar la tarea: ${error.message}`);
      return false;
    }
    return true;
  }

  async fetchCandidates(params: {
    taskId: string;
    limit: number;
    requireAutoAssign: boolean;
  }): Promise<MatchCandidate[]> {
    const { data, error } = await this.client.rpc('match_task_candidates', {
      p_task_id: params.taskId,
      p_limit: params.limit,
      p_require_auto_assign: params.requireAutoAssign,
    });
    if (error !== null) fail('recuperar candidatos', error);
    return ((data ?? []) as CandidateRow[]).map(toCandidate);
  }

  async applyMatches(
    taskId: string,
    matches: readonly ScoredCandidate[],
  ): Promise<ApplyMatchesResult> {
    const { data, error } = await this.client.rpc('apply_task_matches', {
      p_task_id: taskId,
      p_matches: matches.map((match) => ({
        provider_id: match.userId,
        vector_score: match.vectorScore,
        skill_score: match.skillScore,
        reputation_score: match.reputationScore,
        match_score: match.matchScore,
        match_explanation: match.explanation,
      })),
    });
    if (error !== null) fail('escribir las candidaturas', error);

    const payload = (data ?? {}) as {
      written?: number;
      total_applications?: number;
    };
    return {
      taskId,
      written: payload.written ?? 0,
      totalApplications: payload.total_applications ?? 0,
    };
  }

  async bumpMatchingRound(taskId: string): Promise<number> {
    const { data, error } = await this.client.rpc('bump_matching_round', { p_task_id: taskId });
    if (error !== null) fail('registrar la ronda de emparejamiento', error);
    return Number(data ?? 0);
  }

  async findApplicationId(taskId: string, providerId: string): Promise<string | null> {
    const { data, error } = await this.client
      .from('task_applications')
      .select('id')
      .eq('task_id', taskId)
      .eq('provider_id', providerId)
      .maybeSingle();
    if (error !== null) fail('localizar la candidatura', error);
    return data === null ? null : String((data as { id: unknown }).id);
  }

  async acceptApplication(applicationId: string): Promise<AcceptResult> {
    const { data, error } = await this.client.rpc('accept_task_application', {
      p_application_id: applicationId,
    });
    if (error !== null) fail('adjudicar la tarea', error);

    const payload = (data ?? {}) as {
      task_id?: string;
      application_id?: string;
      provider_id?: string;
    };
    return {
      taskId: payload.task_id ?? '',
      applicationId: payload.application_id ?? applicationId,
      providerId: payload.provider_id ?? '',
    };
  }
}
