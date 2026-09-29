/**
 * VEKTORA · FASE 5 — Política de veredicto. Módulo PURO.
 *
 * Recibe los veredictos por criterio y devuelve qué se escribe en la base: estado del
 * entregable, estado de la tarea, puntuación, valoración y movimientos de reputación.
 * Sin red, sin base de datos y sin IA: es el sitio donde el juez puede equivocarse de
 * verdad, así que es el sitio que hay que poder probar exhaustivamente.
 *
 * Tres reglas duras que NO puede tocar el modelo, por orden de importancia:
 *
 *   1. SIN EVIDENCIA NO SE APRUEBA. Un entregable vacío ni siquiera llega al modelo.
 *      Dejar que un modelo decida sobre la nada es pedirle que alucine, y en un sistema
 *      autónomo esa alucinación mueve dinero y reputación.
 *   2. UN FALLO DE INFRAESTRUCTURA NO ES UN RECHAZO. Eso se resuelve en `judge.ts`
 *      dejando el entregable en `error`; aquí no existe ningún camino que convierta una
 *      excepción en veredicto.
 *   3. UN `pass` POCO SEGURO NO SE CUENTA COMO FALLO, SE DEGRADA A `unverifiable`.
 *      La diferencia entre "no lo cumple" y "no puedo comprobarlo" es la diferencia entre
 *      cerrar una tarea y pedir más evidencia.
 */

import type { QaConfig } from './config';
import type { CriterionVerdict } from './schemas';

export const ENGINE_VERSION = 'qa-judge/1.0.0';

export type QaOutcome = 'approved' | 'rejected' | 'revision_requested';
export type TaskOutcome = 'approved' | 'failed' | 'revision_requested';
export type CriterionOutcome = 'pass' | 'fail' | 'unverifiable';

export interface ReputationDelta {
  event_type:
    | 'deliverable_approved'
    | 'deliverable_rejected'
    | 'task_completed'
    | 'task_failed';
  delta: number;
  weight: number;
  reason: string;
}

export interface SubmissionShape {
  summary: string | null;
  content: string | null;
  artifacts: readonly unknown[];
  evidence: Readonly<Record<string, unknown>>;
}

export interface CriterionResult {
  id: string;
  criterion: string;
  /** Lo que dijo el modelo. */
  reported: CriterionOutcome;
  /** Lo que cuenta tras aplicar la política de confianza. */
  outcome: CriterionOutcome;
  confidence: number;
  evidence: string;
  reasoning: string;
  /** true si un `pass` se degradó por confianza insuficiente. */
  downgraded: boolean;
}

export interface QaExplanation {
  engine: string;
  thresholds: {
    approveScore: number;
    revisionFloor: number;
    minConfidence: number;
    maxAttempts: number;
    minAttemptsBeforeReject: number;
  };
  counts: { total: number; passed: number; failed: number; unverifiable: number };
  downgraded: string[];
  attempt: number;
  escalated: boolean;
  summary: string;
  blockingIssues: string[];
}

export interface QaDecision {
  qaStatus: QaOutcome;
  taskStatus: TaskOutcome;
  /** 0-100, dos decimales: la columna es numeric(5,2). */
  score: number;
  /** 0-5, dos decimales: la columna es numeric(3,2). */
  rating: number;
  criteria: CriterionResult[];
  reputation: ReputationDelta[];
  explanation: QaExplanation;
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** ¿Hay algo que juzgar? Un entregable vacío se resuelve sin gastar una llamada al modelo. */
export function hasSubmittedEvidence(submission: SubmissionShape): boolean {
  if ((submission.summary ?? '').trim() !== '') return true;
  if ((submission.content ?? '').trim() !== '') return true;
  if (submission.artifacts.length > 0) return true;
  return Object.keys(submission.evidence).length > 0;
}

/**
 * Veredicto para un entregable sin nada que evaluar.
 *
 * Es `revision_requested` y no `rejected` mientras queden intentos: entregar vacío suele
 * ser un error de envío, no un fraude, y el coste de pedirlo otra vez es un turno. La
 * escalada por número de versión sigue aplicando, así que tampoco se puede entregar vacío
 * indefinidamente.
 */
export function decideEmptySubmission(config: QaConfig, attempt: number): QaDecision {
  const escalated = attempt >= config.maxAttempts;
  const qaStatus: QaOutcome = escalated ? 'rejected' : 'revision_requested';
  const summary = escalated
    ? `El entregable no aporta ninguna evidencia y es el intento ${attempt} de ` +
      `${config.maxAttempts}. Se cierra la tarea.`
    : 'El entregable no aporta ninguna evidencia: no hay resumen, ni contenido, ni ' +
      'artefactos, ni evidencia por criterio. No hay nada que evaluar.';

  return {
    qaStatus,
    taskStatus: escalated ? 'failed' : 'revision_requested',
    score: 0,
    rating: 0,
    criteria: [],
    reputation: escalated ? rejectionEvents(config, 0, attempt) : [],
    explanation: {
      engine: ENGINE_VERSION,
      thresholds: {
        approveScore: config.approveScore,
        revisionFloor: config.revisionFloor,
        minConfidence: config.minConfidence,
        maxAttempts: config.maxAttempts,
        minAttemptsBeforeReject: config.minAttemptsBeforeReject,
      },
      counts: { total: 0, passed: 0, failed: 0, unverifiable: 0 },
      downgraded: [],
      attempt,
      escalated,
      summary,
      blockingIssues: ['El entregable está vacío: no hay evidencia que contrastar.'],
    },
  };
}

function rejectionEvents(config: QaConfig, score: number, attempt: number): ReputationDelta[] {
  return [
    {
      event_type: 'deliverable_rejected',
      delta: -config.reputation.rejected,
      weight: 1,
      reason: `Entregable rechazado por el AI Judge (puntuación ${score.toFixed(2)})`,
    },
    {
      event_type: 'task_failed',
      delta: -config.reputation.taskFailed,
      weight: 1,
      reason: `Tarea agotada tras ${attempt} intento(s)`,
    },
  ];
}

export interface DecideInput {
  /** Criterios de la tarea, en su orden original. */
  criteria: ReadonlyArray<{ id: string; criterion: string }>;
  /** Veredictos del modelo, uno por criterio. */
  verdicts: readonly CriterionVerdict[];
  /** `deliverables.version`: el contador de intentos, que la base ya lleva. */
  attempt: number;
  summary: string;
  blockingIssues: readonly string[];
  config: QaConfig;
}

export function decideVerdict(input: DecideInput): QaDecision {
  const { config } = input;
  const byId = new Map(input.verdicts.map((verdict) => [verdict.id, verdict]));

  const criteria: CriterionResult[] = input.criteria.map((criterion) => {
    const verdict = byId.get(criterion.id);

    // Un criterio sin veredicto NO se da por bueno. El esquema Zod ya lo exige, así que
    // llegar aquí significa que alguien construyó la decisión a mano; el lado seguro es
    // "no comprobado", nunca "cumplido".
    if (verdict === undefined) {
      return {
        id: criterion.id,
        criterion: criterion.criterion,
        reported: 'unverifiable',
        outcome: 'unverifiable',
        confidence: 0,
        evidence: 'El juez no emitió veredicto para este criterio.',
        reasoning: 'Sin veredicto: se cuenta como no comprobado, nunca como cumplido.',
        downgraded: false,
      };
    }

    const lowConfidence = verdict.verdict === 'pass' && verdict.confidence < config.minConfidence;
    return {
      id: criterion.id,
      criterion: criterion.criterion,
      reported: verdict.verdict,
      outcome: lowConfidence ? 'unverifiable' : verdict.verdict,
      confidence: verdict.confidence,
      evidence: verdict.evidence,
      reasoning: verdict.reasoning,
      downgraded: lowConfidence,
    };
  });

  const total = criteria.length;
  const passed = criteria.filter((entry) => entry.outcome === 'pass').length;
  const failed = criteria.filter((entry) => entry.outcome === 'fail').length;
  const unverifiable = criteria.filter((entry) => entry.outcome === 'unverifiable').length;
  const downgraded = criteria.filter((entry) => entry.downgraded).map((entry) => entry.id);

  // Cobertura simple: cuántos criterios se cumplen de los que se pidieron. No se pondera
  // por la confianza que el modelo se asigna a sí mismo — eso sería dejarle mover la nota.
  const score = total === 0 ? 0 : round((passed / total) * 100, 2);

  let qaStatus: QaOutcome;
  if (total === 0) {
    // Una tarea sin criterios no se puede juzgar: el planificador exige al menos uno, así
    // que esto solo pasa con datos escritos a mano. Se pide revisión, no se aprueba.
    qaStatus = 'revision_requested';
  } else if (score >= config.approveScore && failed === 0 && unverifiable === 0) {
    qaStatus = 'approved';
  } else if (
    score < config.revisionFloor &&
    failed > 0 &&
    input.attempt >= config.minAttemptsBeforeReject
  ) {
    // Para CERRAR una tarea hacen falta tres cosas, y ninguna sobra:
    //
    //   · puntuación por debajo del suelo,
    //   · al menos un criterio DEMOSTRADAMENTE incumplido — `score` cuenta cumplidos, así
    //     que un criterio no comprobable lo hunde igual que uno incumplido, y sin esta
    //     condición "no adjuntaste la evidencia" y "entregaste otra cosa" acabarían en el
    //     mismo veredicto, vaciando de sentido a `unverifiable`;
    //   · y que no sea el primer intento. La misma entrega, con el mismo modelo y
    //     temperatura 0, dio `unverifiable` en una corrida y `fail` en la siguiente. Los
    //     dos veredictos eran defendibles; la diferencia entre ellos era pedir una captura
    //     más o cerrar la tarea y descontar reputación. Una sola llamada a un modelo no
    //     puede decidir algo irreversible.
    qaStatus = 'rejected';
  } else {
    qaStatus = 'revision_requested';
  }

  // Escalada: la revisión número `maxAttempts` se convierte en rechazo. Sin esto, el
  // proveedor y el juez pueden quedarse dando vueltas para siempre y la tarea nunca
  // termina, que en un DAG significa que todo lo que dependía de ella tampoco avanza.
  const escalated = qaStatus === 'revision_requested' && input.attempt >= config.maxAttempts;
  if (escalated) qaStatus = 'rejected';

  const taskStatus: TaskOutcome =
    qaStatus === 'approved' ? 'approved' : qaStatus === 'rejected' ? 'failed' : 'revision_requested';

  const rating = round((score / 100) * 5, 2);

  let reputation: ReputationDelta[] = [];
  if (qaStatus === 'approved') {
    reputation = [
      {
        event_type: 'deliverable_approved',
        delta: round(config.reputation.approved * (score / 100), 3),
        weight: 1,
        reason: `Entregable aprobado por el AI Judge (puntuación ${score.toFixed(2)})`,
      },
      {
        event_type: 'task_completed',
        delta: config.reputation.taskCompleted,
        weight: 1,
        reason: 'Tarea completada y aceptada automáticamente',
      },
    ];
  } else if (qaStatus === 'rejected') {
    reputation = rejectionEvents(config, score, input.attempt);
  }
  // `revision_requested` no mueve reputación a propósito: pedir cambios es parte normal
  // del ciclo de trabajo. Penalizar cada iteración haría el sistema hostil justo con quien
  // está corrigiendo lo que se le pidió.

  return {
    qaStatus,
    taskStatus,
    score,
    rating,
    criteria,
    reputation,
    explanation: {
      engine: ENGINE_VERSION,
      thresholds: {
        approveScore: config.approveScore,
        revisionFloor: config.revisionFloor,
        minConfidence: config.minConfidence,
        maxAttempts: config.maxAttempts,
        minAttemptsBeforeReject: config.minAttemptsBeforeReject,
      },
      counts: { total, passed, failed, unverifiable },
      downgraded,
      attempt: input.attempt,
      escalated,
      summary: input.summary,
      blockingIssues: [...input.blockingIssues],
    },
  };
}

/** Una línea legible del veredicto, para la traza y para el comentario de la reseña. */
export function describeDecision(decision: QaDecision): string {
  const { counts } = decision.explanation;
  const parts = [
    `${counts.passed}/${counts.total} criterios cumplidos`,
    `puntuación ${decision.score.toFixed(2)}`,
  ];
  if (counts.failed > 0) parts.push(`${counts.failed} incumplido(s)`);
  if (counts.unverifiable > 0) parts.push(`${counts.unverifiable} sin evidencia suficiente`);
  if (decision.explanation.downgraded.length > 0) {
    parts.push(`${decision.explanation.downgraded.length} aprobado(s) degradado(s) por baja confianza`);
  }
  if (decision.explanation.escalated) {
    parts.push(`intento ${decision.explanation.attempt}: se agotaron las revisiones`);
  }
  return parts.join('; ');
}
