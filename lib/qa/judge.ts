/**
 * VEKTORA · FASE 5 — Orquestación del AI Judge.
 *
 * Entregable -> veredicto persistido, reseña, reputación y tarea avanzada, sin intervención
 * humana:
 *
 *   1. Tomar el turno (la base lo hace atómico: dos jueces no pueden juzgar lo mismo).
 *   2. Leer los criterios de aceptación de la tarea.
 *   3. Si no hay nada que evaluar, resolver sin gastar una llamada al modelo.
 *   4. Pedir al modelo un veredicto POR CRITERIO, validado con Zod y auto-reparado.
 *   5. Calcular el veredicto global con la política pura.
 *   6. Escribirlo todo en una transacción; al aprobar, el trigger de la 0002 desbloquea
 *      las tareas que dependían de esta.
 *
 * El modo de fallo que este archivo existe para evitar: que un problema NUESTRO —modelo
 * caído, cuota agotada, esquema degradado— se convierta en un rechazo. Si la IA no
 * responde, el entregable vuelve a `error`, que es un estado desde el que la RLS permite al
 * proveedor reintentar. Rechazar ahí sería cobrarle a otro nuestra avería.
 */

import { getAiClient, type AiClient } from '@/lib/ai';
import { errorMessage } from '@/lib/ai/errors';
import { getQaConfig, type QaConfig } from './config';
import {
  decideEmptySubmission,
  decideVerdict,
  describeDecision,
  hasSubmittedEvidence,
  type QaDecision,
} from './policy';
import {
  QaRepositoryError,
  type ApplyVerdictResult,
  type QaClaim,
  type QaRepository,
  type QaReleaseStatus,
} from './repository';
import { buildQaVerdictSchema, parseAcceptanceCriteria, type StoredCriterion } from './schemas';
import { QA_SYSTEM_PROMPT, renderJudgePrompt } from './prompts';

export class QaError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'QaError';
  }
}

export interface JudgeInput {
  deliverableId: string;
  /** Calcula el veredicto sin escribirlo y devuelve el entregable a su estado anterior. */
  dryRun?: boolean;
}

export interface JudgeResult {
  deliverableId: string;
  judged: boolean;
  /** Motivo por el que no se juzgó: turno no tomado, IA agotada, veredicto pisado. */
  reason: string | null;
  claim: QaClaim | null;
  criteria: StoredCriterion[];
  /** Criterios almacenados que no se pudieron interpretar. */
  malformedCriteria: number;
  decision: QaDecision | null;
  /** true si se resolvió sin llamar al modelo (entregable vacío o tarea sin criterios). */
  skippedAi: boolean;
  runId: string | null;
  provider: string | null;
  model: string | null;
  repairs: number;
  costUsd: number;
  latencyMs: number;
  applied: ApplyVerdictResult | null;
  dryRun: boolean;
}

export interface QaJudgeOptions {
  repository: QaRepository;
  ai?: AiClient;
  config?: QaConfig;
}

export class QaJudge {
  private readonly repository: QaRepository;
  private readonly config: QaConfig;
  private aiClient: AiClient | null;

  constructor(options: QaJudgeOptions) {
    this.repository = options.repository;
    this.config = options.config ?? getQaConfig();
    this.aiClient = options.ai ?? null;
  }

  private get ai(): AiClient {
    if (this.aiClient === null) this.aiClient = getAiClient();
    return this.aiClient;
  }

  async judge(input: JudgeInput): Promise<JudgeResult> {
    const dryRun = input.dryRun === true;
    const base: JudgeResult = {
      deliverableId: input.deliverableId,
      judged: false,
      reason: null,
      claim: null,
      criteria: [],
      malformedCriteria: 0,
      decision: null,
      skippedAi: false,
      runId: null,
      provider: null,
      model: null,
      repairs: 0,
      costUsd: 0,
      latencyMs: 0,
      applied: null,
      dryRun,
    };

    const claimed = await this.repository.claim(input.deliverableId);
    if (!claimed.claimed || claimed.claim === null) {
      return { ...base, reason: claimed.reason ?? 'no se pudo tomar el entregable' };
    }

    const claim = claimed.claim;
    // A partir de aquí el entregable está en `running`: TODO camino de salida tiene que
    // resolverlo o soltarlo, o se queda bloqueado para siempre y ningún juez lo recogerá.
    const restore = claim.previousStatus as QaReleaseStatus;

    try {
      const parsed = parseAcceptanceCriteria(claim.task.acceptanceCriteria);
      const withClaim: JudgeResult = {
        ...base,
        claim,
        criteria: parsed.criteria,
        malformedCriteria: parsed.malformed,
      };

      // --- Caminos que no necesitan modelo ------------------------------------------------
      if (!hasSubmittedEvidence(claim.deliverable)) {
        const decision = decideEmptySubmission(this.config, claim.deliverable.version);
        return await this.finish({ ...withClaim, decision, skippedAi: true }, restore, dryRun);
      }

      if (parsed.criteria.length === 0) {
        // Sin criterios no hay nada contra lo que contrastar. Aprobar por defecto sería la
        // peor opción posible: cualquiera podría cobrar entregando cualquier cosa.
        const decision = decideVerdict({
          criteria: [],
          verdicts: [],
          attempt: claim.deliverable.version,
          summary:
            'La tarea no tiene criterios de aceptación interpretables, así que no hay nada ' +
            'contra lo que evaluar el entregable. Hay que definirlos antes de poder aceptarlo.',
          blockingIssues: ['La tarea no declara criterios de aceptación válidos.'],
          config: this.config,
        });
        return await this.finish({ ...withClaim, decision, skippedAi: true }, restore, dryRun);
      }

      // --- Veredicto del modelo -----------------------------------------------------------
      const schema = buildQaVerdictSchema(parsed.criteria.map((criterion) => criterion.id));

      let response;
      try {
        response = await this.ai.generateStructured({
          operation: 'qa_judge',
          schema,
          schemaName: 'QaVerdict',
          system: QA_SYSTEM_PROMPT,
          prompt: renderJudgePrompt({
            projectTitle: claim.project.title,
            projectObjective: claim.project.objective,
            taskCode: claim.task.code,
            taskTitle: claim.task.title,
            taskDescription: claim.task.description,
            criteria: parsed.criteria,
            deliverableSummary: claim.deliverable.summary,
            deliverableContent: claim.deliverable.content,
            artifacts: claim.deliverable.artifacts,
            evidence: claim.deliverable.evidence,
          }),
          context: {
            projectId: claim.task.projectId,
            taskId: claim.task.id,
            userId: claim.deliverable.providerId,
          },
          temperature: 0,
          maxOutputTokens: this.config.maxOutputTokens,
        });
      } catch (error) {
        // Avería nuestra, no del proveedor: se suelta como `error` y se puede reintentar.
        const detail = errorMessage(error);
        await this.safeRelease(input.deliverableId, 'error', detail);
        return {
          ...withClaim,
          reason: `el juez no pudo evaluar: ${detail}`,
        };
      }

      const decision = decideVerdict({
        criteria: parsed.criteria,
        verdicts: response.data.criteria,
        attempt: claim.deliverable.version,
        summary: response.data.summary,
        blockingIssues: response.data.blockingIssues,
        config: this.config,
      });

      return await this.finish(
        {
          ...withClaim,
          decision,
          runId: response.runId,
          provider: response.provider,
          model: response.model,
          repairs: response.repairs,
          costUsd: response.costUsd,
          latencyMs: response.latencyMs,
        },
        restore,
        dryRun,
      );
    } catch (error) {
      // Cualquier fallo inesperado deja igualmente el entregable reintentable.
      await this.safeRelease(input.deliverableId, 'error', errorMessage(error));
      if (error instanceof QaRepositoryError) throw error;
      throw new QaError(`VEKTORA/QA: el juicio falló -> ${errorMessage(error)}`, error);
    }
  }

  /** Escribe el veredicto, o lo deshace si es un ensayo. */
  private async finish(
    result: JudgeResult,
    restore: QaReleaseStatus,
    dryRun: boolean,
  ): Promise<JudgeResult> {
    const decision = result.decision;
    if (decision === null) {
      await this.safeRelease(result.deliverableId, restore, null);
      return { ...result, reason: 'no se pudo construir un veredicto' };
    }

    if (dryRun) {
      await this.safeRelease(result.deliverableId, restore, null);
      return { ...result, judged: true, reason: 'ensayo: no se escribió nada' };
    }

    const applied = await this.repository.applyVerdict({
      deliverableId: result.deliverableId,
      qaStatus: decision.qaStatus,
      taskStatus: decision.taskStatus,
      score: decision.score,
      rating: decision.rating,
      qualityScore: decision.rating,
      feedback: {
        engine: decision.explanation.engine,
        summary: decision.explanation.summary,
        blockingIssues: decision.explanation.blockingIssues,
        thresholds: decision.explanation.thresholds,
        counts: decision.explanation.counts,
        downgraded: decision.explanation.downgraded,
        attempt: decision.explanation.attempt,
        escalated: decision.explanation.escalated,
        skippedAi: result.skippedAi,
        malformedCriteria: result.malformedCriteria,
      },
      criteriaResults: decision.criteria,
      runId: result.runId,
      comment: describeDecision(decision),
      reputation: decision.reputation,
    });

    return {
      ...result,
      judged: applied.applied,
      reason: applied.applied ? null : applied.reason,
      applied,
    };
  }

  /**
   * Soltar el turno no puede tumbar el juicio.
   *
   * Si la base tampoco responde aquí, lo que importa es no perder el error ORIGINAL, que es
   * el que explica por qué se estaba soltando.
   */
  private async safeRelease(
    deliverableId: string,
    status: QaReleaseStatus,
    detail: string | null,
  ): Promise<void> {
    try {
      await this.repository.release(deliverableId, status, detail);
    } catch (error) {
      console.warn(
        `VEKTORA/QA: no se pudo devolver el turno de ${deliverableId} -> ${errorMessage(error)}`,
      );
    }
  }

  /** Cola de entregables pendientes, más antiguo primero. */
  async queue(limit?: number): Promise<Awaited<ReturnType<QaRepository['pending']>>> {
    return this.repository.pending(limit ?? this.config.queueLimit);
  }

  /** Juzga la cola entera. Un fallo en uno no detiene a los demás. */
  async judgeQueue(limit?: number, dryRun = false): Promise<JudgeResult[]> {
    const pending = await this.queue(limit);
    const results: JudgeResult[] = [];
    for (const entry of pending) {
      results.push(await this.judge({ deliverableId: entry.deliverableId, dryRun }));
    }
    return results;
  }
}
