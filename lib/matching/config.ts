/**
 * VEKTORA · FASE 4 — Configuración del motor de matching.
 *
 * Todo lo ajustable del ranking vive aquí y se valida con Zod, por la misma razón que la
 * configuración de la capa de IA: un peso mal puesto no falla, solo empeora las
 * adjudicaciones en silencio, y en un sistema sin humanos nadie lo notaría.
 */

import { z } from 'zod';

export const MatchingConfigSchema = z
  .object({
    /** Peso de la similitud semántica entre la tarea y el perfil. */
    VEKTORA_MATCH_W_VECTOR: z.coerce.number().min(0).max(1).default(0.45),
    /** Peso de la cobertura de skills requeridas. */
    VEKTORA_MATCH_W_SKILL: z.coerce.number().min(0).max(1).default(0.35),
    /** Peso de la reputación acumulada. */
    VEKTORA_MATCH_W_REPUTATION: z.coerce.number().min(0).max(1).default(0.2),

    /**
     * Recalibración de la similitud coseno.
     *
     * `gemini-embedding-001` tiene el rango dinámico comprimido, así que usar el coseno
     * crudo como puntuación aplasta las diferencias — un candidato perfecto y uno mediocre
     * quedarían a centésimas. Se reescala el tramo útil a [0, 1] para que el componente
     * vectorial DISCRIMINE.
     *
     * Estos dos números están MEDIDOS sobre la distribución que el matching usa de verdad,
     * TAREA vs PERFIL (`npm run skills:calibrate`): mín 0.7318, mediana 0.7805, máx 0.8607.
     *
     * La ventana anterior, [0.78, 0.98], venía de la muestra skill-vs-skill (textos cortos
     * de dos o tres palabras) y era el error de extrapolar entre dos geometrías distintas:
     * dejaba casi toda la masa real pegada al suelo. Un candidato con cobertura de skills
     * PERFECTA puntuaba 0.2557 en afinidad semántica y su `match_score` se quedaba en
     * 0.5563, por debajo de `autoAssignMin`. Es decir: el motor ordenaba bien pero no
     * adjudicaba nunca, y un sistema que no adjudica necesita una persona — justo lo que
     * la regla 1 del proyecto prohíbe.
     *
     * La ventana se define por los extremos de la muestra, no por percentiles, y con pocos
     * proveedores esos extremos se mueven. Vuelve a correr `npm run skills:calibrate` a
     * medida que crezca el mercado; ambos valores son variables de entorno, así que
     * ajustarlos no exige tocar código ni volver a desplegar.
     */
    VEKTORA_MATCH_VECTOR_FLOOR: z.coerce.number().min(-1).max(1).default(0.73),
    VEKTORA_MATCH_VECTOR_CEILING: z.coerce.number().min(-1).max(1).default(0.89),

    /**
     * Constante de saturación de la reputación: `rep / (rep + K)`. Con K = 50, 50 puntos
     * de reputación valen 0.5. Evita que un veterano con 5000 puntos sea inalcanzable.
     */
    VEKTORA_MATCH_REPUTATION_K: z.coerce.number().positive().default(50),

    /**
     * Valor neutro para proveedores sin historial (`avg_rating` / `on_time_rate` nulos).
     *
     * 0.5 y no 0 a propósito: penalizar la ausencia de historial crea una espiral de
     * arranque en frío en la que quien nunca trabajó nunca puede trabajar, y el mercado
     * no arranca. Se le da el beneficio de la duda y el historial lo corrige.
     */
    VEKTORA_MATCH_NEUTRAL_PRIOR: z.coerce.number().min(0).max(1).default(0.5),

    /** Cobertura mínima de skills para entrar al shortlist. 0 desactiva el filtro. */
    VEKTORA_MATCH_MIN_SKILL_COVERAGE: z.coerce.number().min(0).max(1).default(0.01),
    /** `match_score` mínimo para que un candidato se persista. */
    VEKTORA_MATCH_MIN_SCORE: z.coerce.number().min(0).max(1).default(0.25),
    /** Candidatos que se recuperan de la base antes de puntuar. */
    VEKTORA_MATCH_CANDIDATE_LIMIT: z.coerce.number().int().min(1).max(200).default(20),
    /** Candidaturas que se escriben en `task_applications`. */
    VEKTORA_MATCH_SHORTLIST: z.coerce.number().int().min(1).max(50).default(5),
    /**
     * `match_score` a partir del cual se puede adjudicar sin intervención humana.
     *
     * 0.50, DERIVADO del techo real que puede alcanzar un proveedor NUEVO, no elegido a ojo.
     *
     * El caso que manda es el recién llegado, porque es quien tiene que poder entrar: sin
     * eventos de reputación su componente vale `0.5·0 + 0.3·0.5 + 0.2·0.5 = 0.25`, no 0.4559
     * (esa cifra es la de alguien que YA trabajó). Con todas las skills cubiertas:
     *
     *     0.45·v + 0.35·1.00 + 0.20·0.25  =  0.45·v + 0.40,   v ∈ [0, 0.82]
     *
     * o sea entre 0.40 y 0.77, y con la afinidad semántica MEDIANA medida (0.78 crudo ->
     * 0.31 reescalado) queda en 0.54. Cualquier umbral por encima de eso excluye a todos
     * los proveedores nuevos con fit típico — que es el arranque en frío que el prior neutro
     * existía para evitar, reapareciendo un nivel más arriba.
     *
     * Y excluirlos no deja la tarea «pendiente de revisión»: la deja en `matching` con una
     * candidatura **que nadie puede aceptar**, porque en este sistema no hay nadie. Un
     * umbral inalcanzable no es prudencia, es la regla 1 rota por dentro. El 0.70 anterior
     * era exactamente eso.
     *
     * 0.50 separa bien lo que hay que separar: skills completas + afinidad mediana = 0.54
     * (adjudica); mitad de las skills = 0.4214 en una corrida real (no adjudica); skills
     * completas pero afinidad pésima = 0.40 (no adjudica).
     *
     * Hay que volver a derivarlo cuando los proveedores acumulen historial: el rango se
     * desplaza hacia arriba en cuanto la reputación deja de ser un prior.
     */
    VEKTORA_MATCH_AUTO_ASSIGN_MIN: z.coerce.number().min(0).max(1).default(0.5),

    /**
     * Rondas de emparejamiento sin adjudicar tras las cuales se acepta al mejor candidato
     * que supere el mínimo, aunque no llegue al umbral.
     *
     * Sin esto, una tarea cuyo mejor candidato puntúa 0.49 contra un umbral de 0.50 se
     * queda en `matching` PARA SIEMPRE, con una candidatura pendiente que nadie puede
     * aceptar porque aquí no hay nadie — y todo lo que dependa de ella, bloqueado. Pasó de
     * verdad: dos tareas se pararon en 0.49212 y 0.46834.
     *
     * La lógica es que esperar también cuesta. Al mercado se le dan cuatro oportunidades de
     * producir un candidato claramente bueno; si no aparece, la tarea va al mejor
     * disponible en vez de no hacerse nunca. Es la misma forma que la escalada del
     * evaluador, que convierte la revisión en rechazo tras tres intentos.
     *
     * Se cuenta en RONDAS y no en tiempo a propósito: en producción el reloj dispara cada
     * 15 minutos, así que cuatro rondas es una hora; en una demostración basta con ejecutar
     * el disparador cuatro veces. Medido en horas, la escalada no se podría mostrar.
     */
    VEKTORA_MATCH_ESCALATE_AFTER_ROUNDS: z.coerce.number().int().min(1).max(100).default(4),
  })
  .superRefine((value, ctx) => {
    const sum =
      value.VEKTORA_MATCH_W_VECTOR +
      value.VEKTORA_MATCH_W_SKILL +
      value.VEKTORA_MATCH_W_REPUTATION;
    // Si no suman 1, `match_score` deja de estar en [0,1] y la restricción CHECK de
    // `task_applications.match_score` rechaza el insert a mitad del shortlist.
    if (Math.abs(sum - 1) > 1e-6) {
      ctx.addIssue({
        code: 'custom',
        path: ['VEKTORA_MATCH_W_VECTOR'],
        message: `los tres pesos deben sumar 1.0 y suman ${sum.toFixed(4)}`,
      });
    }
    if (value.VEKTORA_MATCH_VECTOR_CEILING <= value.VEKTORA_MATCH_VECTOR_FLOOR) {
      ctx.addIssue({
        code: 'custom',
        path: ['VEKTORA_MATCH_VECTOR_CEILING'],
        message: 'el techo de recalibración debe ser mayor que el suelo',
      });
    }
  });

export type MatchingEnv = z.infer<typeof MatchingConfigSchema>;

/** Forma usable por el dominio: nombres cortos y agrupados. */
export interface MatchingConfig {
  weights: { vector: number; skill: number; reputation: number };
  vector: { floor: number; ceiling: number };
  reputationK: number;
  neutralPrior: number;
  minSkillCoverage: number;
  minScore: number;
  candidateLimit: number;
  shortlist: number;
  autoAssignMin: number;
  escalateAfterRounds: number;
}

export class MatchingConfigError extends Error {
  constructor(message: string) {
    super(`VEKTORA/MATCH: ${message}`);
    this.name = 'MatchingConfigError';
  }
}

export function loadMatchingConfig(
  env: Record<string, string | undefined> = process.env,
): MatchingConfig {
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string' && value.trim() !== '') cleaned[key] = value;
  }

  const parsed = MatchingConfigSchema.safeParse(cleaned);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(raíz)'}: ${issue.message}`)
      .join('; ');
    throw new MatchingConfigError(`configuración de matching inválida -> ${detail}`);
  }
  const value = parsed.data;

  return {
    weights: {
      vector: value.VEKTORA_MATCH_W_VECTOR,
      skill: value.VEKTORA_MATCH_W_SKILL,
      reputation: value.VEKTORA_MATCH_W_REPUTATION,
    },
    vector: {
      floor: value.VEKTORA_MATCH_VECTOR_FLOOR,
      ceiling: value.VEKTORA_MATCH_VECTOR_CEILING,
    },
    reputationK: value.VEKTORA_MATCH_REPUTATION_K,
    neutralPrior: value.VEKTORA_MATCH_NEUTRAL_PRIOR,
    minSkillCoverage: value.VEKTORA_MATCH_MIN_SKILL_COVERAGE,
    minScore: value.VEKTORA_MATCH_MIN_SCORE,
    candidateLimit: value.VEKTORA_MATCH_CANDIDATE_LIMIT,
    shortlist: value.VEKTORA_MATCH_SHORTLIST,
    autoAssignMin: value.VEKTORA_MATCH_AUTO_ASSIGN_MIN,
    escalateAfterRounds: value.VEKTORA_MATCH_ESCALATE_AFTER_ROUNDS,
  };
}

let cached: MatchingConfig | null = null;

export function getMatchingConfig(): MatchingConfig {
  if (cached === null) cached = loadMatchingConfig();
  return cached;
}

export function resetMatchingConfigCache(): void {
  cached = null;
}
