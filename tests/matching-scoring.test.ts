/**
 * Ranking híbrido. Módulo puro, y el que más importa proteger: una fórmula mal calibrada
 * no falla, solo adjudica peor — y en un sistema sin humanos nadie lo nota.
 */

import { describe, expect, it } from 'vitest';
import { loadMatchingConfig, type MatchingConfig } from '@/lib/matching/config';
import {
  rankCandidates,
  rescaleVectorSimilarity,
  scoreCandidate,
  scoreReputation,
  scoreSkills,
  type MatchCandidate,
  type MatchTaskContext,
} from '@/lib/matching/scoring';

const config: MatchingConfig = loadMatchingConfig({});

const task = (overrides: Partial<MatchTaskContext> = {}): MatchTaskContext => ({
  taskId: 't-1',
  code: 'T-01',
  title: 'Maquetar la landing',
  requiredSkills: ['react', 'tailwind-css'],
  estimatedHours: 8,
  budget: 500,
  hasEmbedding: true,
  ...overrides,
});

const candidate = (overrides: Partial<MatchCandidate> = {}): MatchCandidate => ({
  providerProfileId: 'pp-1',
  userId: 'u-1',
  headline: 'Front-end',
  seniority: 'senior',
  hourlyRateUsd: 50,
  minTaskBudgetUsd: null,
  availabilityHoursWeek: 30,
  reputationScore: 0,
  tasksCompleted: 0,
  tasksFailed: 0,
  avgRating: null,
  onTimeRate: null,
  acceptsAutoAssign: true,
  vectorSimilarity: 0.8,
  skills: [
    { slug: 'react', level: 5 },
    { slug: 'tailwind-css', level: 5 },
  ],
  ...overrides,
});

describe('recalibración del coseno', () => {
  const calibration = { floor: 0.6, ceiling: 0.95 };

  it('sin similitud devuelve null, no cero', () => {
    // Cero diría "es malísimo"; null dice "no lo sé", que es distinto y cambia los pesos.
    expect(rescaleVectorSimilarity(null, calibration)).toBeNull();
  });

  it('recorta fuera del tramo calibrado', () => {
    expect(rescaleVectorSimilarity(0.4, calibration)).toBe(0);
    expect(rescaleVectorSimilarity(0.99, calibration)).toBe(1);
  });

  it('estira el tramo comprimido para que discrimine', () => {
    // 0.775 es el punto medio de [0.60, 0.95]: en crudo parecería "casi idéntico".
    expect(rescaleVectorSimilarity(0.775, calibration)).toBeCloseTo(0.5, 5);
    // Dos candidatos separados por 0.05 en crudo quedan separados por 0.14 tras reescalar.
    const a = rescaleVectorSimilarity(0.9, calibration) ?? 0;
    const b = rescaleVectorSimilarity(0.85, calibration) ?? 0;
    expect(a - b).toBeCloseTo(0.1429, 3);
  });

  it('un tramo degenerado no rompe el cálculo', () => {
    expect(rescaleVectorSimilarity(0.8, { floor: 0.9, ceiling: 0.9 })).toBe(0.8);
  });
});

describe('cobertura de skills', () => {
  it('una tarea sin skills requeridas no penaliza a nadie', () => {
    expect(scoreSkills([], []).score).toBe(1);
  });

  it('cobertura total al nivel máximo da 1', () => {
    const result = scoreSkills(['react'], [{ slug: 'react', level: 5 }]);
    expect(result.score).toBe(1);
    expect(result.missing).toEqual([]);
  });

  it('el nivel declarado pondera', () => {
    expect(scoreSkills(['react'], [{ slug: 'react', level: 3 }]).score).toBeCloseTo(0.6, 5);
  });

  it('las skills que faltan restan en proporción', () => {
    const result = scoreSkills(
      ['react', 'seo', 'devops'],
      [{ slug: 'react', level: 5 }],
    );
    expect(result.score).toBeCloseTo(1 / 3, 4);
    expect(result.coverage).toBeCloseTo(1 / 3, 4);
    expect(result.missing).toEqual(['seo', 'devops']);
  });

  it('tener skills DE MÁS no puntúa: importa cubrir lo que se pide', () => {
    const justo = scoreSkills(['react'], [{ slug: 'react', level: 5 }]);
    const generalista = scoreSkills(
      ['react'],
      [
        { slug: 'react', level: 5 },
        { slug: 'seo', level: 5 },
        { slug: 'devops', level: 5 },
      ],
    );
    expect(generalista.score).toBe(justo.score);
  });

  it('normaliza mayúsculas y deduplica requisitos repetidos', () => {
    const result = scoreSkills(['React', 'react'], [{ slug: 'REACT', level: 5 }]);
    expect(result.score).toBe(1);
    expect(result.matched).toHaveLength(1);
  });

  it('ante dos declaraciones de la misma skill se queda con el nivel mayor', () => {
    const result = scoreSkills(
      ['react'],
      [
        { slug: 'react', level: 2 },
        { slug: 'react', level: 5 },
      ],
    );
    expect(result.score).toBe(1);
  });
});

describe('reputación', () => {
  const reputationConfig = { reputationK: 50, neutralPrior: 0.5 };

  it('un proveedor nuevo recibe el prior neutro, no cero', () => {
    // Penalizar la ausencia de historial crea arranque en frío permanente: quien nunca
    // trabajó nunca podría trabajar.
    const result = scoreReputation(
      { reputationScore: 0, avgRating: null, onTimeRate: null },
      reputationConfig,
    );
    expect(result.usedPrior).toBe(true);
    expect(result.score).toBeCloseTo(0.25, 5); // 0.5*0 + 0.3*0.5 + 0.2*0.5
    expect(result.score).toBeGreaterThan(0);
  });

  it('el volumen satura: 50 puntos valen 0.5', () => {
    expect(
      scoreReputation({ reputationScore: 50, avgRating: null, onTimeRate: null }, reputationConfig)
        .volume,
    ).toBeCloseTo(0.5, 5);
  });

  it('un veterano no deja a todos los demás en cero', () => {
    const veterano = scoreReputation(
      { reputationScore: 5000, avgRating: 5, onTimeRate: 1 },
      reputationConfig,
    );
    const novato = scoreReputation(
      { reputationScore: 0, avgRating: null, onTimeRate: null },
      reputationConfig,
    );
    expect(veterano.score).toBeLessThanOrEqual(1);
    expect(novato.score).toBeGreaterThan(0.2);
  });

  it('una reputación negativa se recorta a cero', () => {
    expect(
      scoreReputation({ reputationScore: -30, avgRating: null, onTimeRate: null }, reputationConfig)
        .volume,
    ).toBe(0);
  });

  it('valoración y puntualidad reales desplazan el prior', () => {
    const bueno = scoreReputation(
      { reputationScore: 10, avgRating: 5, onTimeRate: 1 },
      reputationConfig,
    );
    const malo = scoreReputation(
      { reputationScore: 10, avgRating: 1, onTimeRate: 0.1 },
      reputationConfig,
    );
    expect(bueno.score).toBeGreaterThan(malo.score);
    expect(bueno.usedPrior).toBe(false);
  });
});

describe('puntuación combinada', () => {
  it('guarda el coseno CRUDO en vector_score, no el reescalado', () => {
    const scored = scoreCandidate(task(), candidate({ vectorSimilarity: 0.8 }), config);
    // La recalibración es una decisión de producto que puede cambiar; el dato medido no
    // debe perderse.
    expect(scored.vectorScore).toBeCloseTo(0.8, 5);
    // Con la ventana medida tarea-vs-perfil [0.73, 0.89]: (0.80 - 0.73) / 0.16 = 0.4375
    expect(scored.explanation.vector.rescaled).toBeCloseTo(0.4375, 3);
  });

  it('el match_score está en [0,1], que es lo que exige el CHECK de la tabla', () => {
    for (const similarity of [-1, 0, 0.5, 1]) {
      const scored = scoreCandidate(task(), candidate({ vectorSimilarity: similarity }), config);
      expect(scored.matchScore).toBeGreaterThanOrEqual(0);
      expect(scored.matchScore).toBeLessThanOrEqual(1);
    }
  });

  it('sin vector reparte su peso entre skill y reputación', () => {
    const scored = scoreCandidate(task(), candidate({ vectorSimilarity: null }), config);
    expect(scored.vectorScore).toBeNull();
    expect(scored.explanation.effectiveWeights.vector).toBe(0);
    expect(
      scored.explanation.effectiveWeights.skill + scored.explanation.effectiveWeights.reputation,
    ).toBeCloseTo(1, 6);
    // Poner el peso a cero hundiría a TODOS por igual y el filtro de score mínimo dejaría
    // la tarea sin candidatos.
    expect(scored.matchScore).toBeGreaterThan(0.3);
  });

  it('una tarea sin embedding ignora la similitud aunque el candidato la tenga', () => {
    const scored = scoreCandidate(
      task({ hasEmbedding: false }),
      candidate({ vectorSimilarity: 0.95 }),
      config,
    );
    expect(scored.vectorScore).toBeNull();
  });

  it('la explicación deja auditable cada componente', () => {
    const scored = scoreCandidate(task(), candidate({ skills: [{ slug: 'react', level: 4 }] }), config);
    expect(scored.explanation.skill.missing).toEqual(['tailwind-css']);
    expect(scored.explanation.summary).toContain('tailwind-css');
    expect(scored.explanation.engine).toMatch(/^vektora-match\//);
  });
});

describe('ranking', () => {
  it('ordena por match_score descendente', () => {
    const result = rankCandidates(
      task(),
      [
        candidate({ providerProfileId: 'pp-flojo', userId: 'u-flojo', vectorSimilarity: 0.62, skills: [{ slug: 'react', level: 2 }] }),
        candidate({ providerProfileId: 'pp-bueno', userId: 'u-bueno', vectorSimilarity: 0.94 }),
      ],
      config,
    );
    expect(result.ranked[0]?.userId).toBe('u-bueno');
  });

  it('el desempate es determinista: dos corridas dan el mismo orden', () => {
    const empatados = [
      candidate({ providerProfileId: 'pp-b', userId: 'u-b' }),
      candidate({ providerProfileId: 'pp-a', userId: 'u-a' }),
    ];
    const first = rankCandidates(task(), empatados, config).ranked.map((c) => c.providerProfileId);
    const second = rankCandidates(task(), [...empatados].reverse(), config).ranked.map(
      (c) => c.providerProfileId,
    );
    expect(first).toEqual(second);
    expect(first[0]).toBe('pp-a');
  });

  it('descarta a quien no comparte ninguna skill requerida', () => {
    const result = rankCandidates(
      task(),
      [candidate({ skills: [{ slug: 'soldadura-tig', level: 5 }], vectorSimilarity: 0.99 })],
      config,
    );
    expect(result.ranked).toHaveLength(0);
    expect(result.rejected[0]?.reason).toBe('sin_skills_en_comun');
  });

  it('descarta por puntuación mínima y dice por qué', () => {
    const strict: MatchingConfig = { ...config, minScore: 0.99 };
    const result = rankCandidates(task(), [candidate()], strict);
    expect(result.rejected[0]?.reason).toBe('puntuacion_baja');
    expect(result.rejected[0]?.detail).toContain('0.99');
  });

  it('marca degradado cuando ningún candidato tiene embedding', () => {
    const result = rankCandidates(task(), [candidate({ vectorSimilarity: null })], config);
    expect(result.degraded).toBe(true);
    expect(result.ranked).toHaveLength(1);
  });

  it('sin candidatos devuelve listas vacías, no lanza', () => {
    const result = rankCandidates(task(), [], config);
    expect(result.ranked).toEqual([]);
    expect(result.rejected).toEqual([]);
  });
});

describe('configuración', () => {
  it('rechaza pesos que no suman 1', () => {
    // Si no suman 1, match_score se sale de [0,1] y el CHECK de la tabla rechaza el insert
    // a mitad del shortlist.
    expect(() =>
      loadMatchingConfig({
        VEKTORA_MATCH_W_VECTOR: '0.5',
        VEKTORA_MATCH_W_SKILL: '0.5',
        VEKTORA_MATCH_W_REPUTATION: '0.5',
      }),
    ).toThrowError(/suman/);
  });

  it('rechaza un techo de recalibración por debajo del suelo', () => {
    expect(() =>
      loadMatchingConfig({
        VEKTORA_MATCH_VECTOR_FLOOR: '0.9',
        VEKTORA_MATCH_VECTOR_CEILING: '0.5',
      }),
    ).toThrowError(/mayor que el suelo/);
  });

  it('los valores por defecto son coherentes', () => {
    const defaults = loadMatchingConfig({});
    expect(
      defaults.weights.vector + defaults.weights.skill + defaults.weights.reputation,
    ).toBeCloseTo(1, 6);
    expect(defaults.autoAssignMin).toBeGreaterThan(defaults.minScore);
  });
});

describe('el umbral de adjudicación tiene que ser alcanzable', () => {
  // Una tarea cuyo mejor candidato no llega al umbral queda en `matching` con una
  // candidatura pendiente. En un sistema sin humanos eso no es cautela: no hay nadie que
  // pueda aceptarla, así que la tarea —y todo lo que dependa de ella— se para para siempre.
  const config = loadMatchingConfig({});

  /** El caso que manda: recién llegado, TODAS las skills, cero eventos de reputación. */
  function recienLlegado(rescaled: number): number {
    const sinHistorial = 0.5 * 0 + 0.3 * config.neutralPrior + 0.2 * config.neutralPrior;
    return (
      config.weights.vector * rescaled +
      config.weights.skill * 1 +
      config.weights.reputation * sinHistorial
    );
  }

  it('un recién llegado con todas las skills y afinidad MEDIANA sí se adjudica', () => {
    // Mediana medida tarea-vs-perfil: 0.78 crudo -> 0.31 reescalado en la ventana real.
    // Si esto falla, ningún proveedor nuevo puede entrar nunca al mercado.
    expect(recienLlegado(0.31)).toBeGreaterThan(config.autoAssignMin);
  });

  it('con todas las skills pero afinidad PÉSIMA no se adjudica', () => {
    expect(recienLlegado(0)).toBeLessThan(config.autoAssignMin);
  });

  it('la mitad de las skills NO alcanza, ni con historial', () => {
    const mitad =
      config.weights.vector * 0.42 + config.weights.skill * 0.4 + config.weights.reputation * 0.4559;
    expect(mitad).toBeLessThan(config.autoAssignMin);
  });

  it('el umbral deja margen por encima del mínimo para persistir', () => {
    expect(config.autoAssignMin).toBeGreaterThan(config.minScore);
  });
});
