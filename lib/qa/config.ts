/**
 * VEKTORA · FASE 5 — Configuración del AI Judge.
 *
 * Todo lo que decide un veredicto vive aquí y se valida con Zod. Un umbral mal puesto no
 * lanza ninguna excepción: solo aprueba trabajo que no debería, o rechaza trabajo que sí
 * servía, y en un sistema sin humanos nadie lo revisa después.
 */

import { z } from 'zod';

export const QaConfigSchema = z
  .object({
    /**
     * Puntuación (0-100) a partir de la cual se aprueba.
     *
     * 100 por defecto: los criterios de aceptación son condiciones, no una nota media.
     * Aprobar con 80 significa aceptar que uno de cada cinco criterios no se cumple, y el
     * cliente pidió los cinco. Se deja configurable porque hay dominios donde no es así.
     */
    VEKTORA_QA_APPROVE_SCORE: z.coerce.number().min(0).max(100).default(100),

    /**
     * Por debajo de esta puntuación no se pide revisión: se rechaza.
     *
     * La diferencia importa. `revision_requested` devuelve el trabajo al proveedor y la RLS
     * le permite editarlo; `rejected` cierra la tarea. Pedir revisión de algo que no tiene
     * nada que ver con lo pedido solo quema turnos.
     *
     * OJO: este suelo solo rechaza cuando hay criterios DEMOSTRADAMENTE incumplidos. Si el
     * único problema es que no se pudo comprobar nada, se pide revisión aunque la
     * puntuación sea 0 — ver `decideVerdict`.
     */
    VEKTORA_QA_REVISION_FLOOR: z.coerce.number().min(0).max(100).default(40),

    /**
     * Confianza mínima para aceptar un `pass` del modelo.
     *
     * Un `pass` con confianza baja NO se convierte en fallo: se degrada a `unverifiable`,
     * que pide evidencia en vez de castigar. La confianza decide si nos fiamos del sí, no
     * cuánto vale ese sí: ponderar la puntuación con un número que el propio modelo se
     * asigna sería dejarle mover la nota.
     */
    VEKTORA_QA_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.6),

    /**
     * Intentos que deben existir antes de que el suelo pueda CERRAR una tarea.
     *
     * 2 por defecto: una sola llamada a un modelo no puede cerrar una tarea para siempre.
     * Medido, no supuesto — la misma entrega, con el mismo modelo y temperatura 0, dio
     * `unverifiable` en una corrida y `fail` en la siguiente. Ambos veredictos eran
     * defendibles, y la diferencia entre ellos era "pedí una captura más" frente a "cerrá
     * la tarea y descontá reputación". Dejar un resultado irreversible colgando de esa
     * moneda al aire es el fallo más caro que puede tener un sistema sin humanos.
     *
     * Con este mínimo, el proveedor siempre tiene al menos una oportunidad de responder al
     * veredicto. La escalada por `maxAttempts` sigue cerrando lo que no mejora.
     */
    VEKTORA_QA_MIN_ATTEMPTS_BEFORE_REJECT: z.coerce.number().int().min(1).max(20).default(2),

    /**
     * Versiones del entregable tras las cuales una revisión se convierte en rechazo.
     *
     * `deliverables.version` se asigna sola, así que es el contador de intentos sin
     * necesidad de llevar otro. Sin este tope, un proveedor y el juez pueden quedarse en
     * un bucle de revisiones para siempre, que en un sistema autónomo significa una tarea
     * que nunca termina y un DAG que nunca avanza.
     */
    VEKTORA_QA_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(3),

    /** Reputación que otorga un entregable aprobado, escalada por la puntuación. */
    VEKTORA_QA_APPROVED_DELTA: z.coerce.number().min(0).max(100).default(8),
    /** Reputación adicional por completar la tarea. */
    VEKTORA_QA_TASK_COMPLETED_DELTA: z.coerce.number().min(0).max(100).default(4),
    /** Penalización (magnitud positiva) por entregable rechazado. */
    VEKTORA_QA_REJECTED_DELTA: z.coerce.number().min(0).max(100).default(6),
    /** Penalización (magnitud positiva) por tarea fallida. */
    VEKTORA_QA_TASK_FAILED_DELTA: z.coerce.number().min(0).max(100).default(8),

    /** Entregables que `npm run qa -- --all` procesa de una vez. */
    VEKTORA_QA_QUEUE_LIMIT: z.coerce.number().int().min(1).max(200).default(20),
    /** Tokens máximos de la respuesta del juez. */
    VEKTORA_QA_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(256).max(32_000).default(4_096),
  })
  .superRefine((value, ctx) => {
    if (value.VEKTORA_QA_MIN_ATTEMPTS_BEFORE_REJECT > value.VEKTORA_QA_MAX_ATTEMPTS) {
      ctx.addIssue({
        code: 'custom',
        path: ['VEKTORA_QA_MIN_ATTEMPTS_BEFORE_REJECT'],
        message:
          `no se puede exigir ${value.VEKTORA_QA_MIN_ATTEMPTS_BEFORE_REJECT} intentos para ` +
          `rechazar si solo se permiten ${value.VEKTORA_QA_MAX_ATTEMPTS}`,
      });
    }
    if (value.VEKTORA_QA_REVISION_FLOOR > value.VEKTORA_QA_APPROVE_SCORE) {
      ctx.addIssue({
        code: 'custom',
        path: ['VEKTORA_QA_REVISION_FLOOR'],
        message:
          `el suelo de revisión (${value.VEKTORA_QA_REVISION_FLOOR}) no puede superar el ` +
          `umbral de aprobación (${value.VEKTORA_QA_APPROVE_SCORE}): no quedaría ningún ` +
          'rango en el que pedir cambios',
      });
    }
  });

export type QaEnv = z.infer<typeof QaConfigSchema>;

/** Forma usable por el dominio. */
export interface QaConfig {
  approveScore: number;
  revisionFloor: number;
  minConfidence: number;
  maxAttempts: number;
  minAttemptsBeforeReject: number;
  reputation: {
    approved: number;
    taskCompleted: number;
    rejected: number;
    taskFailed: number;
  };
  queueLimit: number;
  maxOutputTokens: number;
}

export class QaConfigError extends Error {
  constructor(message: string) {
    super(`VEKTORA/QA: ${message}`);
    this.name = 'QaConfigError';
  }
}

export function loadQaConfig(env: Record<string, string | undefined> = process.env): QaConfig {
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string' && value.trim() !== '') cleaned[key] = value;
  }

  const parsed = QaConfigSchema.safeParse(cleaned);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(raíz)'}: ${issue.message}`)
      .join('; ');
    throw new QaConfigError(`configuración del juez inválida -> ${detail}`);
  }
  const value = parsed.data;

  return {
    approveScore: value.VEKTORA_QA_APPROVE_SCORE,
    revisionFloor: value.VEKTORA_QA_REVISION_FLOOR,
    minConfidence: value.VEKTORA_QA_MIN_CONFIDENCE,
    maxAttempts: value.VEKTORA_QA_MAX_ATTEMPTS,
    minAttemptsBeforeReject: value.VEKTORA_QA_MIN_ATTEMPTS_BEFORE_REJECT,
    reputation: {
      approved: value.VEKTORA_QA_APPROVED_DELTA,
      taskCompleted: value.VEKTORA_QA_TASK_COMPLETED_DELTA,
      rejected: value.VEKTORA_QA_REJECTED_DELTA,
      taskFailed: value.VEKTORA_QA_TASK_FAILED_DELTA,
    },
    queueLimit: value.VEKTORA_QA_QUEUE_LIMIT,
    maxOutputTokens: value.VEKTORA_QA_MAX_OUTPUT_TOKENS,
  };
}

let cached: QaConfig | null = null;

export function getQaConfig(): QaConfig {
  if (cached === null) cached = loadQaConfig();
  return cached;
}

export function resetQaConfigCache(): void {
  cached = null;
}
