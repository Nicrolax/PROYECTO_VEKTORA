/**
 * Orquestación del matching, con repositorio y embeddings falsos.
 *
 * Lo que se protege: que el motor NUNCA bloquee el DAG. Sin embeddings, sin candidatos o
 * con una adjudicación perdida por carrera, tiene que degradar y seguir — no lanzar.
 */

import { describe, expect, it, vi } from 'vitest';
import type { EmbeddingService } from '@/lib/ai/embeddings';
import { loadMatchingConfig, type MatchingConfig } from '@/lib/matching/config';
import { MatchingError, TaskMatcher, renderTaskForMatching } from '@/lib/matching/matcher';
import {
  MatchingRepositoryError,
  type AcceptResult,
  type ApplyMatchesResult,
  type MatchingRepository,
  type MatchTaskRecord,
} from '@/lib/matching/repository';
import type { MatchCandidate, ScoredCandidate } from '@/lib/matching/scoring';

const config: MatchingConfig = loadMatchingConfig({});

const taskRecord = (overrides: Partial<MatchTaskRecord> = {}): MatchTaskRecord => ({
  id: 't-1',
  projectId: 'p-1',
  ownerId: 'owner-1',
  code: 'T-01',
  title: 'Maquetar la landing',
  description: 'Landing responsive con formulario',
  status: 'ready',
  matchingRounds: 0,
  requiredSkills: ['react'],
  acceptanceCriteria: [{ id: 'AC-1', criterion: 'Pasa Lighthouse 90' }],
  estimatedHours: 8,
  budget: 500,
  assigneeId: null,
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
  reputationScore: 120,
  tasksCompleted: 10,
  tasksFailed: 0,
  avgRating: 4.8,
  onTimeRate: 0.95,
  acceptsAutoAssign: true,
  vectorSimilarity: 0.93,
  skills: [{ slug: 'react', level: 5 }],
  ...overrides,
});

class FakeRepository implements MatchingRepository {
  readonly applied: ScoredCandidate[][] = [];
  readonly rondas: string[] = [];
  readonly savedEmbeddings: Array<{ taskId: string; model: string }> = [];
  acceptedId: string | null = null;
  /** Simula que otra adjudicación ganó la carrera. */
  acceptRaises23505 = false;
  applicationId: string | null = 'app-1';

  constructor(
    private task: MatchTaskRecord = taskRecord(),
    private readonly candidates: MatchCandidate[] = [candidate()],
  ) {}

  async loadTask(taskId: string): Promise<MatchTaskRecord | null> {
    return taskId === this.task.id ? { ...this.task } : null;
  }

  async bumpMatchingRound(taskId: string): Promise<number> {
    this.rondas.push(taskId);
    this.task = { ...this.task, matchingRounds: this.task.matchingRounds + 1 };
    return this.task.matchingRounds;
  }

  async saveTaskEmbedding(taskId: string, _vector: string, model: string): Promise<boolean> {
    this.savedEmbeddings.push({ taskId, model });
    this.task = { ...this.task, hasEmbedding: true };
    return true;
  }

  async fetchCandidates(params: {
    taskId: string;
    limit: number;
    requireAutoAssign: boolean;
  }): Promise<MatchCandidate[]> {
    return this.candidates
      .filter((entry) => !params.requireAutoAssign || entry.acceptsAutoAssign)
      .slice(0, params.limit);
  }

  async applyMatches(
    taskId: string,
    matches: readonly ScoredCandidate[],
  ): Promise<ApplyMatchesResult> {
    this.applied.push([...matches]);
    return { taskId, written: matches.length, totalApplications: matches.length };
  }

  async findApplicationId(): Promise<string | null> {
    return this.applicationId;
  }

  async acceptApplication(applicationId: string): Promise<AcceptResult> {
    if (this.acceptRaises23505) {
      throw new MatchingRepositoryError('ya está asignada', '23505');
    }
    this.acceptedId = applicationId;
    return { taskId: this.task.id, applicationId, providerId: 'u-1' };
  }
}

function fakeEmbeddings(): EmbeddingService {
  return {
    dimensions: 4,
    isAvailable: () => true,
    describeModel: () => 'fake',
    async embedTexts({ texts }: { texts: string[] }) {
      return {
        vectors: texts.map(() => [0.1, 0.2, 0.3, 0.4]),
        model: 'gemini-embedding-001',
        dimensions: 4,
        usage: {},
        costUsd: 0,
        latencyMs: 1,
        runId: null,
      };
    },
  } as unknown as EmbeddingService;
}

// ---------------------------------------------------------------------------------------

describe('camino feliz', () => {
  it('puntúa, escribe el shortlist y no adjudica salvo que se pida', async () => {
    const repository = new FakeRepository();
    const matcher = new TaskMatcher({ repository, embeddings: null, config });
    const result = await matcher.matchTask({ taskId: 't-1' });

    expect(result.candidates).toBe(1);
    expect(result.shortlist).toHaveLength(1);
    expect(result.written).toBe(1);
    expect(result.assigned).toBeNull();
    expect(repository.acceptedId).toBeNull();
  });

  it('respeta el tamaño del shortlist', async () => {
    const many = Array.from({ length: 12 }, (_, index) =>
      candidate({
        providerProfileId: `pp-${index}`,
        userId: `u-${index}`,
        vectorSimilarity: 0.9 - index * 0.01,
      }),
    );
    const repository = new FakeRepository(taskRecord(), many);
    const matcher = new TaskMatcher({ repository, embeddings: null, config });
    const result = await matcher.matchTask({ taskId: 't-1' });

    expect(result.shortlist).toHaveLength(config.shortlist);
    expect(result.shortlist[0]?.userId).toBe('u-0');
  });
});

describe('adjudicación automática', () => {
  it('adjudica cuando el mejor supera el umbral', async () => {
    const repository = new FakeRepository();
    const matcher = new TaskMatcher({ repository, embeddings: null, config });
    const result = await matcher.matchTask({ taskId: 't-1', assign: true });

    expect(result.assigned).not.toBeNull();
    expect(result.assigned?.providerId).toBe('u-1');
    expect(repository.acceptedId).toBe('app-1');
  });

  it('NO adjudica por debajo del umbral y explica por qué', async () => {
    const strict: MatchingConfig = { ...config, autoAssignMin: 0.99 };
    const repository = new FakeRepository();
    const matcher = new TaskMatcher({ repository, embeddings: null, config: strict });
    const result = await matcher.matchTask({ taskId: 't-1', assign: true });

    expect(result.assigned).toBeNull();
    expect(result.assignmentSkipped).toContain('umbral');
    // El shortlist SÍ se escribe: hay candidatos, solo que ninguno con confianza suficiente.
    expect(result.written).toBe(1);
  });

  it('respeta accepts_auto_assign aunque el candidato llegue en el shortlist', async () => {
    const repository = new FakeRepository(taskRecord(), [
      candidate({ acceptsAutoAssign: false }),
    ]);
    const matcher = new TaskMatcher({ repository, embeddings: null, config });
    // `--manual` lo incluye en el ranking, pero adjudicar sigue prohibido.
    const result = await matcher.matchTask({
      taskId: 't-1',
      assign: true,
      includeManualOnly: true,
    });

    expect(result.shortlist).toHaveLength(1);
    expect(result.assigned).toBeNull();
    expect(result.assignmentSkipped).toContain('no acepta asignación automática');
  });

  it('una carrera perdida no es un fallo: el shortlist queda escrito', async () => {
    const repository = new FakeRepository();
    repository.acceptRaises23505 = true;
    const matcher = new TaskMatcher({ repository, embeddings: null, config });
    const result = await matcher.matchTask({ taskId: 't-1', assign: true });

    expect(result.assigned).toBeNull();
    expect(result.assignmentSkipped).toContain('primero');
    expect(result.written).toBe(1);
  });
});

describe('degradación', () => {
  it('sin embeddings el ranking sigue funcionando', async () => {
    const repository = new FakeRepository(taskRecord({ hasEmbedding: false }), [
      candidate({ vectorSimilarity: null }),
    ]);
    const matcher = new TaskMatcher({ repository, embeddings: null, config });
    const result = await matcher.matchTask({ taskId: 't-1' });

    expect(result.degraded).toBe(true);
    expect(result.shortlist).toHaveLength(1);
    expect(result.shortlist[0]?.vectorScore).toBeNull();
  });

  it('vectoriza la tarea si le falta el embedding', async () => {
    const repository = new FakeRepository(taskRecord({ hasEmbedding: false }));
    const matcher = new TaskMatcher({ repository, embeddings: fakeEmbeddings(), config });
    const result = await matcher.matchTask({ taskId: 't-1' });

    expect(result.taskEmbedded).toBe(true);
    expect(repository.savedEmbeddings).toHaveLength(1);
  });

  it('si falla la vectorización sigue adelante con el ranking determinista', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const broken = {
      isAvailable: () => true,
      async embedTexts() {
        throw new Error('429');
      },
    } as unknown as EmbeddingService;

    const repository = new FakeRepository(taskRecord({ hasEmbedding: false }));
    const matcher = new TaskMatcher({ repository, embeddings: broken, config });
    const result = await matcher.matchTask({ taskId: 't-1' });

    expect(result.taskEmbedded).toBe(false);
    expect(result.shortlist).toHaveLength(1);
  });

  it('sin candidatos no lanza: informa y deja la tarea intacta', async () => {
    const repository = new FakeRepository(taskRecord(), []);
    const matcher = new TaskMatcher({ repository, embeddings: null, config });
    const result = await matcher.matchTask({ taskId: 't-1' });

    expect(result.shortlist).toEqual([]);
    expect(result.written).toBe(0);
    expect(result.assignmentSkipped).toContain('ningún candidato');
    expect(repository.applied).toHaveLength(0);
  });
});

describe('guardas', () => {
  it('falla si la tarea no existe', async () => {
    const repository = new FakeRepository();
    const matcher = new TaskMatcher({ repository, embeddings: null, config });
    await expect(matcher.matchTask({ taskId: 'inexistente' })).rejects.toThrowError(MatchingError);
  });

  it('falla si la tarea ya está asignada', async () => {
    const repository = new FakeRepository(taskRecord({ assigneeId: 'u-9' }));
    const matcher = new TaskMatcher({ repository, embeddings: null, config });
    await expect(matcher.matchTask({ taskId: 't-1' })).rejects.toThrowError(/ya está asignada/);
  });

  it('dry-run no escribe nada', async () => {
    const repository = new FakeRepository();
    const matcher = new TaskMatcher({ repository, embeddings: null, config });
    const result = await matcher.matchTask({ taskId: 't-1', dryRun: true });

    expect(result.shortlist).toHaveLength(1);
    expect(result.written).toBe(0);
    expect(repository.applied).toHaveLength(0);
  });
});

describe('representación vectorial', () => {
  it('el texto de la tarea es simétrico con el del proveedor', () => {
    const text = renderTaskForMatching(taskRecord());
    // Mismas secciones que `renderProviderForEmbedding`: si no son comparables, la
    // distancia coseno entre tarea y perfil no significa nada.
    expect(text).toContain('Maquetar la landing');
    expect(text).toContain('Skills requeridas: react');
    expect(text).toContain('Pasa Lighthouse 90');
  });

  it('tolera una tarea sin descripción ni criterios', () => {
    const text = renderTaskForMatching(
      taskRecord({ description: null, acceptanceCriteria: [] }),
    );
    expect(text).toContain('Maquetar la landing');
    expect(text).not.toContain('Criterios');
  });
});

describe('escalada: una tarea nunca queda trabada', () => {
  // Salió de una corrida real: dos tareas puntuaron 0.49212 y 0.46834 contra un umbral de
  // 0.50 y se quedaron en `matching` con una candidatura pendiente. Nadie podía aceptarla
  // —en este sistema no hay nadie— así que esas tareas, y todo lo que dependiera de ellas,
  // estaban paradas para siempre.
  const casiSuficiente = (): MatchCandidate =>
    candidate({ vectorSimilarity: 0.76, skills: [{ slug: 'react', level: 2 }] });

  it('por debajo del umbral NO adjudica, pero cuenta la ronda', async () => {
    const repository = new FakeRepository(taskRecord({ matchingRounds: 0 }), [casiSuficiente()]);
    const resultado = await new TaskMatcher({ repository, embeddings: null, config }).matchTask({
      taskId: 't-1',
      assign: true,
    });

    expect(resultado.assigned).toBeNull();
    expect(resultado.escalated).toBe(false);
    expect(repository.rondas).toEqual(['t-1']);
    expect(resultado.assignmentSkipped).toContain('ronda 1');
  });

  it('agotadas las rondas, adjudica al mejor disponible', async () => {
    const repository = new FakeRepository(
      taskRecord({ matchingRounds: config.escalateAfterRounds }),
      [casiSuficiente()],
    );
    const resultado = await new TaskMatcher({ repository, embeddings: null, config }).matchTask({
      taskId: 't-1',
      assign: true,
    });

    expect(resultado.assigned).not.toBeNull();
    expect(resultado.escalated).toBe(true);
    // La traza tiene que decir que fue por agotamiento: es una decisión distinta de haber
    // superado el umbral, y quien la audite después necesita saberlo.
    expect(resultado.assignmentSkipped).toContain('agotamiento');
  });

  it('una ronda antes todavía espera', async () => {
    const repository = new FakeRepository(
      taskRecord({ matchingRounds: config.escalateAfterRounds - 1 }),
      [casiSuficiente()],
    );
    const resultado = await new TaskMatcher({ repository, embeddings: null, config }).matchTask({
      taskId: 't-1',
      assign: true,
    });
    expect(resultado.assigned).toBeNull();
  });

  it('la escalada NO baja del mínimo de persistencia', async () => {
    // Escalar no es adjudicar a cualquiera: quien no llega ni al mínimo nunca entró al
    // shortlist, así que no hay a quién adjudicar.
    const inservible = candidate({ vectorSimilarity: 0, skills: [] });
    const repository = new FakeRepository(taskRecord({ matchingRounds: 99 }), [inservible]);
    const resultado = await new TaskMatcher({ repository, embeddings: null, config }).matchTask({
      taskId: 't-1',
      assign: true,
    });
    expect(resultado.assigned).toBeNull();
  });

  it('un ENSAYO no acerca la tarea a la escalada', async () => {
    // Mirar el ranking no puede consumir oportunidades del mercado.
    const repository = new FakeRepository(taskRecord({ matchingRounds: 0 }), [casiSuficiente()]);
    await new TaskMatcher({ repository, embeddings: null, config }).matchTask({ taskId: 't-1', dryRun: true });
    expect(repository.rondas).toEqual([]);
  });

  it('adjudicar por encima del umbral no marca escalada', async () => {
    const repository = new FakeRepository(taskRecord({ matchingRounds: 99 }), [candidate()]);
    const resultado = await new TaskMatcher({ repository, embeddings: null, config }).matchTask({
      taskId: 't-1',
      assign: true,
    });
    expect(resultado.assigned).not.toBeNull();
    expect(resultado.escalated).toBe(false);
  });

  it('si no se puede registrar la ronda, el emparejamiento sigue', async () => {
    // Perder la cuenta de una ronda solo retrasa la escalada; abortar dejaría la tarea sin
    // candidaturas escritas, que es peor.
    const repository = new FakeRepository(taskRecord({ matchingRounds: 0 }), [casiSuficiente()]);
    repository.bumpMatchingRound = async () => {
      throw new Error('la base no responde');
    };
    const resultado = await new TaskMatcher({ repository, embeddings: null, config }).matchTask({
      taskId: 't-1',
      assign: true,
    });
    expect(resultado.written).toBeGreaterThan(0);
  });
});
