/**
 * Política de veredicto del AI Judge. Módulo puro, y el que más importa proteger: un juez
 * mal calibrado no falla, solo aprueba trabajo que no cumple o cierra tareas que sí
 * servían — y en un sistema sin humanos nadie lo revisa después.
 */

import { describe, expect, it } from 'vitest';
import { loadQaConfig, type QaConfig } from '@/lib/qa/config';
import {
  decideEmptySubmission,
  decideVerdict,
  describeDecision,
  hasSubmittedEvidence,
  ENGINE_VERSION,
} from '@/lib/qa/policy';
import type { CriterionVerdict } from '@/lib/qa/schemas';

const config: QaConfig = loadQaConfig({});

const criteria = [
  { id: 'AC-1', criterion: 'Incluye objetivos medibles' },
  { id: 'AC-2', criterion: 'Lista lo que queda fuera de alcance' },
];

function verdict(
  id: string,
  outcome: CriterionVerdict['verdict'],
  confidence = 0.9,
): CriterionVerdict {
  return {
    id,
    verdict: outcome,
    confidence,
    evidence: 'Sección 2, párrafo 1',
    reasoning: 'La evidencia citada responde exactamente a lo que pide el criterio.',
  };
}

function decide(verdicts: CriterionVerdict[], attempt = 1, overrides: Partial<QaConfig> = {}) {
  return decideVerdict({
    criteria,
    verdicts,
    attempt,
    summary: 'Resumen del juez con suficiente longitud para ser útil al proveedor.',
    blockingIssues: [],
    config: { ...config, ...overrides },
  });
}

describe('hasSubmittedEvidence', () => {
  const empty = { summary: null, content: null, artifacts: [], evidence: {} };

  it('un entregable sin nada no tiene evidencia', () => {
    expect(hasSubmittedEvidence(empty)).toBe(false);
  });

  it('los espacios en blanco no cuentan como contenido', () => {
    expect(hasSubmittedEvidence({ ...empty, summary: '   ', content: '\n\t ' })).toBe(false);
  });

  it('cualquiera de los cuatro campos basta', () => {
    expect(hasSubmittedEvidence({ ...empty, summary: 'algo' })).toBe(true);
    expect(hasSubmittedEvidence({ ...empty, content: 'algo' })).toBe(true);
    expect(hasSubmittedEvidence({ ...empty, artifacts: [{ url: 'x' }] })).toBe(true);
    expect(hasSubmittedEvidence({ ...empty, evidence: { 'AC-1': 'x' } })).toBe(true);
  });
});

describe('entrega vacía', () => {
  it('NUNCA se aprueba, ni con la puntuación de aprobación en 0', () => {
    const decision = decideEmptySubmission({ ...config, approveScore: 0 }, 1);
    expect(decision.qaStatus).not.toBe('approved');
    expect(decision.score).toBe(0);
  });

  it('el primer intento pide revisión y no mueve reputación', () => {
    const decision = decideEmptySubmission(config, 1);
    expect(decision.qaStatus).toBe('revision_requested');
    expect(decision.taskStatus).toBe('revision_requested');
    expect(decision.reputation).toEqual([]);
  });

  it('agotados los intentos, se cierra la tarea y se penaliza', () => {
    const decision = decideEmptySubmission(config, config.maxAttempts);
    expect(decision.qaStatus).toBe('rejected');
    expect(decision.taskStatus).toBe('failed');
    expect(decision.reputation.map((event) => event.event_type)).toEqual([
      'deliverable_rejected',
      'task_failed',
    ]);
    expect(decision.reputation.every((event) => event.delta < 0)).toBe(true);
  });
});

describe('veredicto global', () => {
  it('todos cumplidos -> aprobado, con reputación y tarea aprobada', () => {
    const decision = decide([verdict('AC-1', 'pass'), verdict('AC-2', 'pass')]);
    expect(decision.qaStatus).toBe('approved');
    expect(decision.taskStatus).toBe('approved');
    expect(decision.score).toBe(100);
    expect(decision.rating).toBe(5);
    expect(decision.reputation.map((event) => event.event_type)).toEqual([
      'deliverable_approved',
      'task_completed',
    ]);
  });

  it('un criterio incumplido impide aprobar aunque el resto esté perfecto', () => {
    const decision = decide([verdict('AC-1', 'pass'), verdict('AC-2', 'fail')]);
    expect(decision.qaStatus).toBe('revision_requested');
    expect(decision.score).toBe(50);
  });

  it('un criterio SIN EVIDENCIA tampoco deja aprobar', () => {
    // La diferencia con `fail` es qué se le pide al proveedor, no si se aprueba.
    const decision = decide([verdict('AC-1', 'pass'), verdict('AC-2', 'unverifiable')]);
    expect(decision.qaStatus).toBe('revision_requested');
    expect(decision.explanation.counts.unverifiable).toBe(1);
  });

  it('por debajo del suelo se rechaza — pero nunca al primer intento', () => {
    const primero = decide([verdict('AC-1', 'fail'), verdict('AC-2', 'fail')], 1);
    expect(primero.score).toBe(0);
    expect(primero.qaStatus).toBe('revision_requested');

    const segundo = decide([verdict('AC-1', 'fail'), verdict('AC-2', 'fail')], 2);
    expect(segundo.qaStatus).toBe('rejected');
    expect(segundo.taskStatus).toBe('failed');
  });

  it('pedir cambios NO mueve reputación', () => {
    // Penalizar cada iteración haría el sistema hostil justo con quien está corrigiendo.
    const decision = decide([verdict('AC-1', 'pass'), verdict('AC-2', 'fail')]);
    expect(decision.reputation).toEqual([]);
  });

  it('la reputación del aprobado escala con la puntuación', () => {
    const relajado = { approveScore: 50 };
    const parcial = decide([verdict('AC-1', 'pass'), verdict('AC-2', 'pass')], 1, relajado);
    expect(parcial.reputation[0]?.delta).toBe(config.reputation.approved);
  });
});

describe('confianza', () => {
  it('un pass poco seguro se degrada a "sin evidencia", NO a fallo', () => {
    const decision = decide([verdict('AC-1', 'pass', 0.2), verdict('AC-2', 'pass')]);
    expect(decision.criteria[0]?.reported).toBe('pass');
    expect(decision.criteria[0]?.outcome).toBe('unverifiable');
    expect(decision.criteria[0]?.downgraded).toBe(true);
    expect(decision.explanation.counts.failed).toBe(0);
    expect(decision.qaStatus).toBe('revision_requested');
  });

  it('la confianza baja en un FALLO no lo convierte en otra cosa', () => {
    const decision = decide([verdict('AC-1', 'fail', 0.1), verdict('AC-2', 'pass')]);
    expect(decision.criteria[0]?.outcome).toBe('fail');
    expect(decision.criteria[0]?.downgraded).toBe(false);
  });

  it('la confianza NO pondera la puntuación', () => {
    // Si la ponderase, el modelo podría subirse la nota subiendo su propia confianza.
    const seguro = decide([verdict('AC-1', 'pass', 1), verdict('AC-2', 'pass', 1)]);
    const justo = decide([
      verdict('AC-1', 'pass', config.minConfidence),
      verdict('AC-2', 'pass', config.minConfidence),
    ]);
    expect(seguro.score).toBe(justo.score);
  });
});

describe('escalada', () => {
  it('la revisión número maxAttempts se convierte en rechazo', () => {
    const decision = decide([verdict('AC-1', 'pass'), verdict('AC-2', 'fail')], config.maxAttempts);
    expect(decision.qaStatus).toBe('rejected');
    expect(decision.taskStatus).toBe('failed');
    expect(decision.explanation.escalated).toBe(true);
  });

  it('un intento antes todavía se puede corregir', () => {
    const decision = decide(
      [verdict('AC-1', 'pass'), verdict('AC-2', 'fail')],
      config.maxAttempts - 1,
    );
    expect(decision.qaStatus).toBe('revision_requested');
    expect(decision.explanation.escalated).toBe(false);
  });

  it('la escalada NO convierte un aprobado en rechazo', () => {
    const decision = decide([verdict('AC-1', 'pass'), verdict('AC-2', 'pass')], 99);
    expect(decision.qaStatus).toBe('approved');
  });
});

describe('robustez', () => {
  it('un criterio sin veredicto cuenta como NO comprobado, nunca como cumplido', () => {
    const decision = decide([verdict('AC-1', 'pass')]);
    expect(decision.criteria[1]?.outcome).toBe('unverifiable');
    expect(decision.qaStatus).not.toBe('approved');
  });

  it('una tarea sin criterios no se aprueba por defecto', () => {
    const decision = decideVerdict({
      criteria: [],
      verdicts: [],
      attempt: 1,
      summary: 'No hay criterios registrados en la tarea, así que no hay nada que contrastar.',
      blockingIssues: [],
      config,
    });
    expect(decision.qaStatus).toBe('revision_requested');
    expect(decision.score).toBe(0);
  });

  it('el match_score y la valoración respetan el rango de las columnas', () => {
    for (const outcome of ['pass', 'fail', 'unverifiable'] as const) {
      const decision = decide([verdict('AC-1', outcome), verdict('AC-2', outcome)]);
      expect(decision.score).toBeGreaterThanOrEqual(0);
      expect(decision.score).toBeLessThanOrEqual(100);
      expect(decision.rating).toBeGreaterThanOrEqual(0);
      expect(decision.rating).toBeLessThanOrEqual(5);
      for (const event of decision.reputation) {
        expect(Math.abs(event.delta)).toBeLessThanOrEqual(100);
      }
    }
  });

  it('la explicación guarda los umbrales con los que se decidió', () => {
    const decision = decide([verdict('AC-1', 'pass'), verdict('AC-2', 'pass')]);
    expect(decision.explanation.engine).toBe(ENGINE_VERSION);
    expect(decision.explanation.thresholds.approveScore).toBe(config.approveScore);
    expect(describeDecision(decision)).toContain('2/2 criterios cumplidos');
  });
});

describe('configuración', () => {
  it('rechaza un suelo de revisión por encima del umbral de aprobación', () => {
    // Con floor > approve no queda ningún rango en el que pedir cambios: todo sería
    // aprobado o rechazado, y la fase de revisión desaparecería en silencio.
    expect(() =>
      loadQaConfig({ VEKTORA_QA_APPROVE_SCORE: '80', VEKTORA_QA_REVISION_FLOOR: '90' }),
    ).toThrowError(/suelo de revisión/);
  });

  it('acepta una política más laxa si se declara explícitamente', () => {
    const relajado = loadQaConfig({
      VEKTORA_QA_APPROVE_SCORE: '80',
      VEKTORA_QA_REVISION_FLOOR: '30',
    });
    expect(relajado.approveScore).toBe(80);
    expect(relajado.revisionFloor).toBe(30);
  });

  it('por defecto exige TODOS los criterios', () => {
    // Aprobar con 80 sobre 100 significa aceptar que uno de cada cinco criterios que el
    // cliente pidió no se cumple.
    expect(loadQaConfig({}).approveScore).toBe(100);
  });

  it('la cadena vacía se trata como variable ausente', () => {
    expect(loadQaConfig({ VEKTORA_QA_MAX_ATTEMPTS: '   ' }).maxAttempts).toBe(3);
  });
});

describe('sin evidencia NO es lo mismo que incumplido', () => {
  // Esto salió de una corrida real: una entrega cuyo contenido no hablaba de los criterios
  // dio 2 unverifiable, puntuación 0, y la política CERRÓ la tarea al primer intento.
  // `score` cuenta cumplidos, así que un criterio no comprobable la hunde igual que uno
  // incumplido — y eso vaciaba de sentido a `unverifiable`.
  it('todo sin comprobar con puntuación 0 pide revisión, NO cierra la tarea', () => {
    const decision = decide([verdict('AC-1', 'unverifiable'), verdict('AC-2', 'unverifiable')]);
    expect(decision.score).toBe(0);
    expect(decision.qaStatus).toBe('revision_requested');
    expect(decision.taskStatus).toBe('revision_requested');
    expect(decision.reputation).toEqual([]);
  });

  it('todo INCUMPLIDO con puntuación 0 cierra la tarea, a partir del segundo intento', () => {
    const decision = decide([verdict('AC-1', 'fail'), verdict('AC-2', 'fail')], 2);
    expect(decision.qaStatus).toBe('rejected');
    expect(decision.taskStatus).toBe('failed');
  });

  it('un incumplimiento demostrado basta para que el suelo rechace', () => {
    const decision = decide([verdict('AC-1', 'fail'), verdict('AC-2', 'unverifiable')], 2);
    expect(decision.score).toBe(0);
    expect(decision.qaStatus).toBe('rejected');
  });

  it('pero sin evidencia tampoco se puede reintentar para siempre', () => {
    const decision = decide(
      [verdict('AC-1', 'unverifiable'), verdict('AC-2', 'unverifiable')],
      config.maxAttempts,
    );
    expect(decision.qaStatus).toBe('rejected');
    expect(decision.explanation.escalated).toBe(true);
  });

  it('un pass degradado por confianza tampoco cierra la tarea', () => {
    // El degradado produce `unverifiable`: tiene que seguir el mismo camino.
    const decision = decide([verdict('AC-1', 'pass', 0.1), verdict('AC-2', 'pass', 0.1)]);
    expect(decision.score).toBe(0);
    expect(decision.qaStatus).toBe('revision_requested');
  });
});

describe('un solo veredicto no puede cerrar una tarea', () => {
  // Salió de dos corridas reales consecutivas: la MISMA entrega, el mismo modelo y
  // temperatura 0 dieron `unverifiable` las dos veces primero, y `fail` las dos veces
  // después. Los dos veredictos eran defendibles; la diferencia entre ellos era pedir una
  // captura más o cerrar la tarea y descontar 14 puntos de reputación.
  it('el primer intento nunca es irreversible, por malo que sea', () => {
    const decision = decide([verdict('AC-1', 'fail'), verdict('AC-2', 'fail')], 1);
    expect(decision.qaStatus).toBe('revision_requested');
    expect(decision.taskStatus).toBe('revision_requested');
    expect(decision.reputation).toEqual([]);
  });

  it('el veredicto que SÍ es irreversible deja constancia del umbral que lo permitió', () => {
    const decision = decide([verdict('AC-1', 'fail'), verdict('AC-2', 'fail')], 2);
    expect(decision.explanation.thresholds.minAttemptsBeforeReject).toBe(2);
  });

  it('la aprobación no espera a un segundo intento', () => {
    // La cautela va en una sola dirección: lo reversible no necesita protección.
    const decision = decide([verdict('AC-1', 'pass'), verdict('AC-2', 'pass')], 1);
    expect(decision.qaStatus).toBe('approved');
  });

  it('no se puede exigir más intentos para rechazar de los que se permiten', () => {
    expect(() =>
      loadQaConfig({
        VEKTORA_QA_MAX_ATTEMPTS: '2',
        VEKTORA_QA_MIN_ATTEMPTS_BEFORE_REJECT: '5',
      }),
    ).toThrowError(/solo se permiten 2/);
  });
});
