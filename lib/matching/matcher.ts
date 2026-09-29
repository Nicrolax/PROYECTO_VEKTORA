/**
 * VEKTORA · FASE 4 — Orquestación del matching híbrido.
 *
 * Tarea -> shortlist de candidaturas puntuadas y explicadas, y opcionalmente adjudicación,
 * sin intervención humana.
 *
 *   1. Cargar la tarea y comprobar que sigue disponible.
 *   2. Vectorizarla si le falta el embedding (una tarea sin vector nunca tendría
 *      componente semántico, y el planificador degrada en silencio cuando falla).
 *   3. Recuperar candidatos elegibles (ANN + filtros duros, en la base).
 *   4. Puntuar y ordenar con el módulo puro.
 *   5. Persistir el shortlist con su explicación.
 *   6. Adjudicar si el mejor supera el umbral — solo cuando se pide explícitamente.
 *
 * Degrada en tres puntos y no falla en ninguno: sin embedding de tarea, sin embeddings de
 * proveedor, y sin candidatos. Un motor que lanza excepciones cuando el mercado está vacío
 * bloquearía el DAG entero.
 */

import { getEmbeddingService, toPgVector, type EmbeddingService } from '@/lib/ai/embeddings';
import { errorMessage, isAiError } from '@/lib/ai/errors';
import { getMatchingConfig, type MatchingConfig } from './config';
import {
  MatchingRepositoryError,
  type MatchTaskRecord,
  type MatchingRepository,
} from './repository';
import {
  rankCandidates,
  type MatchCandidate,
  type MatchTaskContext,
  type RejectedCandidate,
  type ScoredCandidate,
} from './scoring';

export class MatchingError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'MatchingError';
  }
}

export interface MatchTaskInput {
  taskId: string;
  /** Adjudica automáticamente si el mejor candidato supera el umbral. Por defecto NO. */
  assign?: boolean;
  /** Incluye proveedores que NO aceptan asignación automática (revisión manual). */
  includeManualOnly?: boolean;
  /** Vectoriza la tarea si le falta el embedding. Por defecto sí. */
  embedTask?: boolean;
  /** Calcula y devuelve el ranking sin escribir nada. */
  dryRun?: boolean;
}

export interface MatchTaskResult {
  task: MatchTaskRecord;
  /** Candidatos recuperados de la base antes de puntuar. */
  candidates: number;
  shortlist: ScoredCandidate[];
  rejected: RejectedCandidate[];
  written: number;
  /** true si el ranking fue puramente determinista por falta de embeddings. */
  degraded: boolean;
  taskEmbedded: boolean;
  assigned: { applicationId: string; providerId: string } | null;
  /** Por qué no se adjudicó, cuando se pidió adjudicar y no se pudo. */
  assignmentSkipped: string | null;
  /**
   * true si se adjudicó por agotamiento de rondas y no por superar el umbral. Queda en la
   * traza: una adjudicación por escalada es una decisión distinta y hay que poder auditarla.
   */
  escalated: boolean;
}

export interface TaskMatcherOptions {
  repository: MatchingRepository;
  embeddings?: EmbeddingService | null;
  config?: MatchingConfig;
}

export class TaskMatcher {
  private readonly repository: MatchingRepository;
  private readonly embeddings: EmbeddingService | null;
  private readonly config: MatchingConfig;

  constructor(options: TaskMatcherOptions) {
    this.repository = options.repository;
    this.embeddings =
      options.embeddings !== undefined ? options.embeddings : getEmbeddingService();
    this.config = options.config ?? getMatchingConfig();
  }

  async matchTask(input: MatchTaskInput): Promise<MatchTaskResult> {
    // --- 1. Tarea ----------------------------------------------------------------------
    const task = await this.repository.loadTask(input.taskId);
    if (task === null) {
      throw new MatchingError(
        `VEKTORA/MATCH: la tarea ${input.taskId} no existe o no es accesible`,
      );
    }
    if (task.assigneeId !== null) {
      throw new MatchingError(
        `VEKTORA/MATCH: la tarea ${task.code} ya está asignada a ${task.assigneeId}`,
      );
    }

    // --- 2. Embedding de la tarea --------------------------------------------------------
    let hasEmbedding = task.hasEmbedding;
    let taskEmbedded = false;
    if (!hasEmbedding && input.embedTask !== false) {
      taskEmbedded = await this.embedTask(task);
      hasEmbedding = taskEmbedded;
    }

    // --- 3. Candidatos -------------------------------------------------------------------
    const candidates = await this.repository.fetchCandidates({
      taskId: task.id,
      limit: this.config.candidateLimit,
      requireAutoAssign: input.includeManualOnly !== true,
    });

    const context: MatchTaskContext = {
      taskId: task.id,
      code: task.code,
      title: task.title,
      requiredSkills: task.requiredSkills,
      estimatedHours: task.estimatedHours,
      budget: task.budget,
      hasEmbedding,
    };

    // --- 4. Ranking ----------------------------------------------------------------------
    const ranking = rankCandidates(context, candidates, this.config);
    const shortlist = ranking.ranked.slice(0, this.config.shortlist);

    const base: MatchTaskResult = {
      task,
      candidates: candidates.length,
      shortlist,
      rejected: ranking.rejected,
      written: 0,
      degraded: ranking.degraded,
      taskEmbedded,
      assigned: null,
      assignmentSkipped: null,
      escalated: false,
    };

    if (input.dryRun === true || shortlist.length === 0) {
      // Un ensayo NO cuenta ronda: calcular el ranking para mirarlo no puede acercar la
      // tarea a una adjudicación por agotamiento.
      if (shortlist.length > 0 || input.dryRun === true) {
        return {
          ...base,
          assignmentSkipped:
            shortlist.length === 0 ? 'no hay ningún candidato que supere los filtros' : null,
        };
      }
    }

    // Sin candidatos y sin ensayo, la ronda cuenta igual: el mercado tuvo su oportunidad.
    if (shortlist.length === 0) {
      const rondas = await this.registrarRonda(task.id);
      return {
        ...base,
        assignmentSkipped:
          `no hay ningún candidato que supere los filtros (ronda ${rondas} de ` +
          `${this.config.escalateAfterRounds})`,
      };
    }

    // --- 5. Persistencia -------------------------------------------------------------------
    const applied = await this.repository.applyMatches(task.id, shortlist);

    if (input.assign !== true) {
      return { ...base, written: applied.written };
    }

    // --- 6. Adjudicación --------------------------------------------------------------------
    const assignment = await this.tryAssign(task.id, shortlist, candidates, task.matchingRounds);
    return { ...base, written: applied.written, ...assignment };
  }

  // ---------------------------------------------------------------------------------------

  /**
   * Registra una ronda fallida. Si la base no responde, se sigue adelante: perder la cuenta
   * de una ronda solo retrasa la escalada, mientras que abortar el emparejamiento entero
   * por eso dejaría la tarea sin candidaturas escritas.
   */
  private async registrarRonda(taskId: string): Promise<number> {
    try {
      return await this.repository.bumpMatchingRound(taskId);
    } catch (error) {
      console.warn(`[vektora/match] no se pudo registrar la ronda -> ${errorMessage(error)}`);
      return 0;
    }
  }

  private async embedTask(task: MatchTaskRecord): Promise<boolean> {
    const embeddings = this.embeddings;
    if (embeddings === null || !embeddings.isAvailable()) return false;
    try {
      const response = await embeddings.embedTexts({
        texts: [renderTaskForMatching(task)],
        taskType: 'RETRIEVAL_DOCUMENT',
      });
      const vector = response.vectors[0];
      if (vector === undefined) return false;
      return await this.repository.saveTaskEmbedding(
        task.id,
        toPgVector(vector, response.dimensions),
        response.model,
      );
    } catch (error) {
      // Sin vector el matching cae al ranking determinista: se degrada, no se falla.
      const detail = isAiError(error) ? error.code : errorMessage(error);
      console.warn(`[vektora/match] tarea sin vectorizar (${detail}): ranking determinista`);
      return false;
    }
  }

  /**
   * Umbral efectivo de esta ronda.
   *
   * Tras `escalateAfterRounds` búsquedas sin adjudicar, el umbral baja al mínimo de
   * persistencia. No es relajar el criterio por comodidad: es que una tarea cuyo mejor
   * candidato se queda a centésimas del umbral no puede esperar indefinidamente a un
   * candidato mejor que quizá no exista. Sin esto, la tarea se para para siempre y con ella
   * todo lo que dependa de ella — y no hay nadie que pueda desatascarla.
   */
  private umbralEfectivo(rondasPrevias: number): { umbral: number; escalado: boolean } {
    const escalado = rondasPrevias >= this.config.escalateAfterRounds;
    return { umbral: escalado ? this.config.minScore : this.config.autoAssignMin, escalado };
  }

  private async tryAssign(
    taskId: string,
    shortlist: readonly ScoredCandidate[],
    candidates: readonly MatchCandidate[],
    rondasPrevias: number,
  ): Promise<Pick<MatchTaskResult, 'assigned' | 'assignmentSkipped' | 'escalated'>> {
    const best = shortlist[0];
    if (best === undefined) {
      return { assigned: null, assignmentSkipped: 'shortlist vacío', escalated: false };
    }

    const { umbral, escalado } = this.umbralEfectivo(rondasPrevias);

    if (best.matchScore < umbral) {
      // No se adjudicó: esta ronda cuenta. Al llegar al tope, la siguiente escalará.
      const rondas = await this.registrarRonda(taskId);
      const restantes = Math.max(0, this.config.escalateAfterRounds - rondas);
      return {
        assigned: null,
        escalated: false,
        assignmentSkipped:
          `el mejor candidato puntúa ${best.matchScore} y el umbral de adjudicación ` +
          `automática es ${umbral}: ronda ${rondas} de ${this.config.escalateAfterRounds}` +
          (restantes === 0
            ? '. En la próxima ronda se adjudicará al mejor disponible.'
            : `, faltan ${restantes} para adjudicar al mejor disponible.`),
      };
    }

    // Consentimiento explícito. El filtro de la base ya lo aplica, pero se vuelve a
    // comprobar aquí: adjudicar trabajo a quien no lo pidió no es autonomía.
    const candidate = candidates.find(
      (entry) => entry.providerProfileId === best.providerProfileId,
    );
    if (candidate !== undefined && !candidate.acceptsAutoAssign) {
      return {
        assigned: null,
        escalated: false,
        assignmentSkipped: 'el mejor candidato no acepta asignación automática',
      };
    }

    const applicationId = await this.repository.findApplicationId(taskId, best.userId);
    if (applicationId === null) {
      return {
        assigned: null,
        escalated: false,
        assignmentSkipped: 'no se encontró la candidatura recién escrita',
      };
    }

    try {
      const accepted = await this.repository.acceptApplication(applicationId);
      // «Escalada» significa que se adjudicó SOLO porque se agotaron las rondas. Si el
      // candidato superaba el umbral normal, ganó por mérito propio y marcarlo como
      // escalada sería falsear la traza.
      const porAgotamiento = escalado && best.matchScore < this.config.autoAssignMin;
      return {
        assigned: { applicationId: accepted.applicationId, providerId: accepted.providerId },
        escalated: porAgotamiento,
        assignmentSkipped: porAgotamiento
          ? `adjudicada por agotamiento: tras ${rondasPrevias} rondas sin que nadie superara ` +
            `${this.config.autoAssignMin}, se aceptó al mejor disponible (${best.matchScore})`
          : null,
      };
    } catch (error) {
      // Otra adjudicación ganó la carrera: no es un fallo del motor, el shortlist queda
      // escrito y la tarea tiene dueño.
      if (error instanceof MatchingRepositoryError && error.isAlreadyAssigned) {
        return { assigned: null, escalated: false, assignmentSkipped: 'otra adjudicación llegó primero' };
      }
      throw error;
    }
  }
}

/**
 * Texto que representa la tarea en el espacio vectorial.
 *
 * Debe ser SIMÉTRICO con `renderProviderForEmbedding` de la FASE 3.5 y con
 * `renderTaskForEmbedding` del planificador: si las representaciones no son comparables,
 * la distancia coseno entre ellas no significa nada.
 */
export function renderTaskForMatching(task: MatchTaskRecord): string {
  const criteria = task.acceptanceCriteria
    .map((entry) =>
      typeof entry === 'object' && entry !== null
        ? String((entry as { criterion?: unknown }).criterion ?? '')
        : String(entry),
    )
    .filter((text) => text !== '');

  return [
    task.title,
    task.description ?? '',
    `Skills requeridas: ${task.requiredSkills.join(', ')}`,
    criteria.length > 0 ? `Criterios de aceptación: ${criteria.join(' | ')}` : '',
  ]
    .filter((line) => line.trim() !== '')
    .join('\n');
}
