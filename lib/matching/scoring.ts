/**
 * VEKTORA · FASE 4 — Ranking híbrido. Módulo PURO: sin red, sin base de datos.
 *
 * Aquí vive la política del matching, y está separada de la recuperación a propósito: la
 * base hace la búsqueda aproximada de vecinos (lo único que solo ella puede hacer) y este
 * módulo decide QUÉ significa ser un buen candidato. Esa decisión cambia con el producto y
 * tiene que poder probarse exhaustivamente, cosa imposible dentro de una función SQL.
 *
 * Tres componentes, todos normalizados a [0,1] para que los pesos signifiquen algo:
 *
 *   vector      qué tan parecido es el perfil a la tarea, semánticamente
 *   skill       qué fracción de las skills requeridas cubre, ponderada por nivel
 *   reputación  historial: puntos acumulados, valoración media y cumplimiento de plazos
 *
 * `match_score = Σ peso · componente`. Con los pesos sumando 1, el resultado está en [0,1],
 * que es lo que exige la restricción CHECK de `task_applications.match_score`.
 */

import type { MatchingConfig } from './config';

export interface CandidateSkill {
  slug: string;
  /** 1 a 5, tal como lo declaró el proveedor. */
  level: number;
}

export interface MatchCandidate {
  providerProfileId: string;
  userId: string;
  headline: string | null;
  seniority: string | null;
  hourlyRateUsd: number | null;
  minTaskBudgetUsd: number | null;
  availabilityHoursWeek: number | null;
  reputationScore: number;
  tasksCompleted: number;
  tasksFailed: number;
  avgRating: number | null;
  onTimeRate: number | null;
  acceptsAutoAssign: boolean;
  /** Coseno crudo contra el embedding de la tarea. `null` si falta alguno de los dos. */
  vectorSimilarity: number | null;
  skills: CandidateSkill[];
}

export interface MatchTaskContext {
  taskId: string;
  code: string;
  title: string;
  requiredSkills: string[];
  estimatedHours: number | null;
  budget: number | null;
  /** `false` cuando la tarea no tiene embedding: el componente vectorial no aplica. */
  hasEmbedding: boolean;
}

export interface SkillBreakdown {
  score: number;
  matched: Array<{ slug: string; level: number }>;
  missing: string[];
  coverage: number;
}

export interface ReputationBreakdown {
  score: number;
  volume: number;
  rating: number;
  onTime: number;
  /** true si se usó el prior neutro por falta de historial. */
  usedPrior: boolean;
}

export interface MatchExplanation {
  engine: string;
  weights: MatchingConfig['weights'];
  /** Pesos realmente aplicados: si falta el vector, su peso se reparte. */
  effectiveWeights: MatchingConfig['weights'];
  vector: { similarity: number | null; rescaled: number | null; calibration: { floor: number; ceiling: number } };
  skill: SkillBreakdown;
  reputation: ReputationBreakdown;
  summary: string;
}

export interface ScoredCandidate {
  providerProfileId: string;
  userId: string;
  /** Titular del perfil. Va aquí para que la traza sea legible sin volver a la base. */
  headline: string | null;
  /** Coseno crudo recortado a [0,1]; es lo que se guarda en `vector_score`. */
  vectorScore: number | null;
  skillScore: number;
  reputationScore: number;
  matchScore: number;
  explanation: MatchExplanation;
}

export interface RejectedCandidate {
  providerProfileId: string;
  userId: string;
  headline: string | null;
  reason: 'sin_skills_en_comun' | 'cobertura_insuficiente' | 'puntuacion_baja';
  detail: string;
  matchScore: number;
}

export interface RankingResult {
  ranked: ScoredCandidate[];
  rejected: RejectedCandidate[];
  /** true si ningún candidato tenía embedding: el ranking fue puramente determinista. */
  degraded: boolean;
}

export const ENGINE_VERSION = 'vektora-match/1.0';

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));
const round5 = (value: number): number => Math.round(value * 100_000) / 100_000;

/**
 * Coseno crudo -> [0,1] utilizable.
 *
 * Sin esto el componente vectorial no discrimina: con `gemini-embedding-001` casi todas
 * las similitudes caen entre 0.60 y 0.95, así que un candidato excelente y uno mediocre
 * diferirían en centésimas y el peso del vector sería decorativo.
 */
export function rescaleVectorSimilarity(
  similarity: number | null,
  calibration: { floor: number; ceiling: number },
): number | null {
  if (similarity === null || !Number.isFinite(similarity)) return null;
  const span = calibration.ceiling - calibration.floor;
  if (span <= 0) return clamp01(similarity);
  return clamp01((similarity - calibration.floor) / span);
}

/**
 * Cobertura de las skills requeridas, ponderada por nivel declarado.
 *
 * Cada skill requerida que el proveedor tiene aporta `level / 5`; las que no tiene aportan
 * 0. Se divide por el número de requeridas, así que tener skills DE MÁS no puntúa: lo que
 * importa es cubrir lo que la tarea pide, no ser generalista.
 *
 * Una tarea sin skills declaradas da cobertura 1: no se puede penalizar a nadie por no
 * cubrir un requisito que no existe.
 */
export function scoreSkills(
  requiredSkills: readonly string[],
  providerSkills: readonly CandidateSkill[],
): SkillBreakdown {
  const required = [...new Set(requiredSkills.map((slug) => slug.trim().toLowerCase()))].filter(
    (slug) => slug !== '',
  );
  if (required.length === 0) {
    return { score: 1, matched: [], missing: [], coverage: 1 };
  }

  const owned = new Map<string, number>();
  for (const skill of providerSkills) {
    const slug = skill.slug.trim().toLowerCase();
    if (slug === '') continue;
    const level = Number.isFinite(skill.level) ? Math.min(5, Math.max(1, skill.level)) : 3;
    owned.set(slug, Math.max(owned.get(slug) ?? 0, level));
  }

  const matched: Array<{ slug: string; level: number }> = [];
  const missing: string[] = [];
  let total = 0;

  for (const slug of required) {
    const level = owned.get(slug);
    if (level === undefined) {
      missing.push(slug);
      continue;
    }
    matched.push({ slug, level });
    total += level / 5;
  }

  return {
    score: round5(clamp01(total / required.length)),
    matched,
    missing,
    coverage: round5(matched.length / required.length),
  };
}

/**
 * Reputación a [0,1].
 *
 * `volume` satura: `rep / (rep + K)`. Sin saturación, un veterano con 5000 puntos dejaría
 * a todos los demás en cero y el mercado se cerraría sobre sí mismo.
 *
 * `rating` y `onTime` usan el prior neutro cuando no hay historial. Penalizar la ausencia
 * de historial produce arranque en frío permanente: quien nunca trabajó nunca puede
 * trabajar.
 */
export function scoreReputation(
  candidate: Pick<MatchCandidate, 'reputationScore' | 'avgRating' | 'onTimeRate'>,
  config: Pick<MatchingConfig, 'reputationK' | 'neutralPrior'>,
): ReputationBreakdown {
  const reputation = Math.max(0, candidate.reputationScore);
  const volume = reputation / (reputation + config.reputationK);

  const hasRating = candidate.avgRating !== null && Number.isFinite(candidate.avgRating);
  const hasOnTime = candidate.onTimeRate !== null && Number.isFinite(candidate.onTimeRate);

  const rating = hasRating ? clamp01((candidate.avgRating ?? 0) / 5) : config.neutralPrior;
  const onTime = hasOnTime ? clamp01(candidate.onTimeRate ?? 0) : config.neutralPrior;

  return {
    score: round5(clamp01(0.5 * volume + 0.3 * rating + 0.2 * onTime)),
    volume: round5(volume),
    rating: round5(rating),
    onTime: round5(onTime),
    usedPrior: !hasRating || !hasOnTime,
  };
}

/**
 * Reparte el peso del componente vectorial entre los otros dos cuando no hay embeddings.
 * Ponerlo a cero sería peor que no tenerlo: hundiría el `match_score` de TODOS por igual
 * y luego el filtro de puntuación mínima dejaría la tarea sin candidatos.
 */
function redistributeWeights(
  weights: MatchingConfig['weights'],
  hasVector: boolean,
): MatchingConfig['weights'] {
  if (hasVector) return weights;
  const rest = weights.skill + weights.reputation;
  if (rest <= 0) return { vector: 0, skill: 0.5, reputation: 0.5 };
  return {
    vector: 0,
    skill: weights.skill / rest,
    reputation: weights.reputation / rest,
  };
}

function renderSummary(
  skill: SkillBreakdown,
  reputation: ReputationBreakdown,
  rescaled: number | null,
): string {
  const parts: string[] = [];
  parts.push(
    skill.missing.length === 0
      ? `cubre las ${skill.matched.length} skills requeridas`
      : `cubre ${skill.matched.length}/${skill.matched.length + skill.missing.length} skills (falta: ${skill.missing.join(', ')})`,
  );
  parts.push(
    rescaled === null
      ? 'sin similitud semántica disponible'
      : `afinidad semántica ${(rescaled * 100).toFixed(0)}%`,
  );
  parts.push(
    reputation.usedPrior
      ? 'sin historial suficiente: se aplica valor neutro'
      : `historial ${(reputation.score * 100).toFixed(0)}%`,
  );
  return parts.join('; ');
}

/** Puntúa un candidato. No decide si entra al shortlist: eso lo hace `rankCandidates`. */
export function scoreCandidate(
  task: MatchTaskContext,
  candidate: MatchCandidate,
  config: MatchingConfig,
): ScoredCandidate {
  const similarity =
    task.hasEmbedding && candidate.vectorSimilarity !== null ? candidate.vectorSimilarity : null;
  const rescaled = rescaleVectorSimilarity(similarity, config.vector);

  const skill = scoreSkills(task.requiredSkills, candidate.skills);
  const reputation = scoreReputation(candidate, config);
  const effectiveWeights = redistributeWeights(config.weights, rescaled !== null);

  const matchScore = round5(
    clamp01(
      effectiveWeights.vector * (rescaled ?? 0) +
        effectiveWeights.skill * skill.score +
        effectiveWeights.reputation * reputation.score,
    ),
  );

  return {
    providerProfileId: candidate.providerProfileId,
    userId: candidate.userId,
    headline: candidate.headline,
    // `vector_score` guarda el coseno CRUDO recortado, no el reescalado: la recalibración
    // es una decisión de producto que puede cambiar, y el dato medido no debe perderse.
    vectorScore: similarity === null ? null : round5(clamp01(similarity)),
    skillScore: skill.score,
    reputationScore: reputation.score,
    matchScore,
    explanation: {
      engine: ENGINE_VERSION,
      weights: config.weights,
      effectiveWeights,
      vector: { similarity, rescaled, calibration: config.vector },
      skill,
      reputation,
      summary: renderSummary(skill, reputation, rescaled),
    },
  };
}

/**
 * Puntúa, filtra y ordena. El desempate es determinista (skill, luego reputación, luego
 * uuid) para que dos ejecuciones sobre los mismos datos produzcan el mismo shortlist:
 * una adjudicación automática que cambia al azar no se puede auditar.
 */
export function rankCandidates(
  task: MatchTaskContext,
  candidates: readonly MatchCandidate[],
  config: MatchingConfig,
): RankingResult {
  const ranked: ScoredCandidate[] = [];
  const rejected: RejectedCandidate[] = [];
  let anyVector = false;

  for (const candidate of candidates) {
    const scored = scoreCandidate(task, candidate, config);
    if (scored.explanation.vector.rescaled !== null) anyVector = true;

    const coverage = scored.explanation.skill.coverage;
    const requiresSkills = task.requiredSkills.length > 0;

    if (requiresSkills && scored.explanation.skill.matched.length === 0) {
      rejected.push({
        providerProfileId: scored.providerProfileId,
        userId: scored.userId,
        headline: scored.headline,
        reason: 'sin_skills_en_comun',
        detail: `no declara ninguna de: ${task.requiredSkills.join(', ')}`,
        matchScore: scored.matchScore,
      });
      continue;
    }
    if (requiresSkills && coverage < config.minSkillCoverage) {
      rejected.push({
        providerProfileId: scored.providerProfileId,
        userId: scored.userId,
        headline: scored.headline,
        reason: 'cobertura_insuficiente',
        detail: `cobertura ${coverage} < ${config.minSkillCoverage}`,
        matchScore: scored.matchScore,
      });
      continue;
    }
    if (scored.matchScore < config.minScore) {
      rejected.push({
        providerProfileId: scored.providerProfileId,
        userId: scored.userId,
        headline: scored.headline,
        reason: 'puntuacion_baja',
        detail: `match_score ${scored.matchScore} < ${config.minScore}`,
        matchScore: scored.matchScore,
      });
      continue;
    }
    ranked.push(scored);
  }

  ranked.sort(
    (a, b) =>
      b.matchScore - a.matchScore ||
      b.skillScore - a.skillScore ||
      b.reputationScore - a.reputationScore ||
      a.providerProfileId.localeCompare(b.providerProfileId),
  );

  return { ranked, rejected, degraded: !anyVector };
}
