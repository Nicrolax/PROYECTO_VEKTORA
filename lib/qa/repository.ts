/**
 * VEKTORA · FASE 5 — Acceso a datos del AI Judge.
 *
 * Mismo patrón que planner, providers y matching: el dominio habla con esta interfaz, así
 * la política —que es donde el juez puede equivocarse— se prueba sin base de datos.
 *
 * Las cuatro operaciones son RPC y no consultas sueltas por una razón concreta: tomar el
 * turno y escribir el veredicto tienen que ser atómicos. `supabase-js` no tiene
 * transacciones multi-sentencia, así que hacerlo desde aquí dejaría ventanas en las que dos
 * jueces juzgan lo mismo o una tarea queda aprobada sin reseña.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { toNumber, type PgNumeric } from '@/lib/supabase/types';
import type { QaOutcome, ReputationDelta, TaskOutcome } from './policy';

export interface QaClaim {
  deliverable: {
    id: string;
    taskId: string;
    providerId: string;
    version: number;
    summary: string | null;
    content: string | null;
    artifacts: unknown[];
    evidence: Record<string, unknown>;
    submittedAt: string;
  };
  task: {
    id: string;
    projectId: string;
    code: string;
    title: string;
    description: string | null;
    acceptanceCriteria: unknown;
    requiredSkills: string[];
    status: string;
    assigneeId: string | null;
    budget: number | null;
    estimatedHours: number | null;
  };
  project: { id: string; title: string; objective: string };
  previousStatus: string;
  previousRejections: number;
}

export interface QaClaimResult {
  claimed: boolean;
  reason: string | null;
  qaStatus: string | null;
  claim: QaClaim | null;
}

export interface ApplyVerdictInput {
  deliverableId: string;
  qaStatus: QaOutcome;
  taskStatus: TaskOutcome;
  score: number;
  rating: number;
  qualityScore: number | null;
  feedback: Record<string, unknown>;
  criteriaResults: unknown[];
  runId: string | null;
  comment: string | null;
  reputation: readonly ReputationDelta[];
}

export interface ApplyVerdictResult {
  applied: boolean;
  reason: string | null;
  reviewId: string | null;
  reputationWritten: number;
  reputationSkipped: string[];
}

export interface PendingDeliverable {
  deliverableId: string;
  taskId: string;
  projectId: string;
  taskCode: string;
  taskTitle: string;
  providerId: string;
  version: number;
  qaStatus: string;
  submittedAt: string;
  criteriaCount: number;
}

/**
 * Estados a los que se puede devolver un turno tomado. No incluye los terminales: soltar un
 * entregable como `approved` sin pasar por `apply_qa_verdict` lo dejaría aprobado sin reseña
 * ni reputación, que es un estado del que nadie se recupera solo.
 */
export type QaReleaseStatus = 'pending' | 'revision_requested' | 'error';

export interface QaRepository {
  claim(deliverableId: string): Promise<QaClaimResult>;
  release(deliverableId: string, status: QaReleaseStatus, error: string | null): Promise<boolean>;
  applyVerdict(input: ApplyVerdictInput): Promise<ApplyVerdictResult>;
  pending(limit: number): Promise<PendingDeliverable[]>;
  /** Último entregable juzgable de una tarea; `npm run qa -- --task <id>` lo usa. */
  latestDeliverableForTask(taskId: string): Promise<string | null>;
}

export class QaRepositoryError extends Error {
  readonly code: string | undefined;
  readonly details: unknown;

  constructor(message: string, code?: string, details?: unknown) {
    super(message);
    this.name = 'QaRepositoryError';
    this.code = code;
    this.details = details;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export class SupabaseQaRepository implements QaRepository {
  constructor(private readonly client: SupabaseClient) {}

  async claim(deliverableId: string): Promise<QaClaimResult> {
    const { data, error } = await this.client.rpc('claim_deliverable_for_qa', {
      p_deliverable_id: deliverableId,
    });
    if (error !== null) {
      throw new QaRepositoryError(
        `VEKTORA/QA: no se pudo tomar el entregable -> ${error.message}`,
        error.code,
        error,
      );
    }

    const payload = asRecord(data);
    if (payload['claimed'] !== true) {
      return {
        claimed: false,
        reason: asString(payload['reason']) ?? 'la base no explicó el motivo',
        qaStatus: asString(payload['qa_status']),
        claim: null,
      };
    }

    const deliverable = asRecord(payload['deliverable']);
    const task = asRecord(payload['task']);
    const project = asRecord(payload['project']);

    return {
      claimed: true,
      reason: null,
      qaStatus: 'running',
      claim: {
        deliverable: {
          id: String(deliverable['id']),
          taskId: String(deliverable['task_id']),
          providerId: String(deliverable['provider_id']),
          version: Number(deliverable['version'] ?? 1),
          summary: asString(deliverable['summary']),
          content: asString(deliverable['content']),
          artifacts: asArray(deliverable['artifacts']),
          evidence: asRecord(deliverable['evidence']),
          submittedAt: String(deliverable['submitted_at'] ?? ''),
        },
        task: {
          id: String(task['id']),
          projectId: String(task['project_id']),
          code: String(task['code'] ?? ''),
          title: String(task['title'] ?? ''),
          description: asString(task['description']),
          acceptanceCriteria: task['acceptance_criteria'],
          requiredSkills: asArray(task['required_skills']).map((slug) => String(slug)),
          status: String(task['status'] ?? ''),
          assigneeId: asString(task['assignee_id']),
          budget: toNumber(task['budget'] as PgNumeric | null),
          estimatedHours: toNumber(task['estimated_hours'] as PgNumeric | null),
        },
        project: {
          id: String(project['id']),
          title: String(project['title'] ?? ''),
          objective: String(project['objective'] ?? ''),
        },
        previousStatus: asString(payload['previous_status']) ?? 'pending',
        previousRejections: Number(payload['previous_rejections'] ?? 0),
      },
    };
  }

  async release(
    deliverableId: string,
    status: QaReleaseStatus,
    error: string | null,
  ): Promise<boolean> {
    const { data, error: rpcError } = await this.client.rpc('release_deliverable_qa', {
      p_deliverable_id: deliverableId,
      p_status: status,
      p_error: error,
    });
    if (rpcError !== null) {
      throw new QaRepositoryError(
        `VEKTORA/QA: no se pudo devolver el turno -> ${rpcError.message}`,
        rpcError.code,
        rpcError,
      );
    }
    return data === true;
  }

  async applyVerdict(input: ApplyVerdictInput): Promise<ApplyVerdictResult> {
    const { data, error } = await this.client.rpc('apply_qa_verdict', {
      p_deliverable_id: input.deliverableId,
      p_qa_status: input.qaStatus,
      p_qa_score: input.score,
      p_qa_feedback: input.feedback,
      p_qa_criteria_results: input.criteriaResults,
      p_task_status: input.taskStatus,
      p_rating: input.rating,
      p_qa_run_id: input.runId,
      p_quality_score: input.qualityScore,
      p_timeliness_score: null,
      p_comment: input.comment,
      p_reputation: input.reputation,
    });
    if (error !== null) {
      throw new QaRepositoryError(
        `VEKTORA/QA: no se pudo aplicar el veredicto -> ${error.message}`,
        error.code,
        error,
      );
    }

    const payload = asRecord(data);
    return {
      applied: payload['applied'] === true,
      reason: asString(payload['reason']),
      reviewId: asString(payload['review_id']),
      reputationWritten: Number(payload['reputation_written'] ?? 0),
      reputationSkipped: asArray(payload['reputation_skipped']).map((entry) => String(entry)),
    };
  }

  async pending(limit: number): Promise<PendingDeliverable[]> {
    const { data, error } = await this.client.rpc('pending_qa_deliverables', { p_limit: limit });
    if (error !== null) {
      throw new QaRepositoryError(
        `VEKTORA/QA: no se pudo leer la cola -> ${error.message}`,
        error.code,
        error,
      );
    }

    return asArray(data).map((entry) => {
      const row = asRecord(entry);
      return {
        deliverableId: String(row['deliverable_id']),
        taskId: String(row['task_id']),
        projectId: String(row['project_id']),
        taskCode: String(row['task_code'] ?? ''),
        taskTitle: String(row['task_title'] ?? ''),
        providerId: String(row['provider_id']),
        version: Number(row['version'] ?? 1),
        qaStatus: String(row['qa_status'] ?? ''),
        submittedAt: String(row['submitted_at'] ?? ''),
        criteriaCount: Number(row['criteria_count'] ?? 0),
      };
    });
  }

  async latestDeliverableForTask(taskId: string): Promise<string | null> {
    const { data, error } = await this.client
      .from('deliverables')
      .select('id, version, qa_status')
      .eq('task_id', taskId)
      .order('version', { ascending: false })
      .limit(1);
    if (error !== null) {
      throw new QaRepositoryError(
        `VEKTORA/QA: no se pudo buscar el entregable de la tarea -> ${error.message}`,
        error.code,
        error,
      );
    }
    const row = (data ?? [])[0] as { id?: unknown } | undefined;
    return row === undefined ? null : String(row.id);
  }
}
