/**
 * ProjectPlanner de punta a punta, con IA y repositorio falsos.
 *
 * Cubre las cuatro capas de defensa del grafo, el reparto de presupuesto, el orden
 * topológico persistido, el crecimiento del catálogo de skills y la degradación de los
 * embeddings. Sin red y sin base de datos: lo único que se ejercita es la lógica, que es
 * donde el planificador puede equivocarse de verdad.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiClient, StructuredResponse } from '@/lib/ai/ai-client';
import { AiExhaustedError } from '@/lib/ai/errors';
import type { EmbeddingService } from '@/lib/ai/embeddings';
import { isAcyclic } from '@/lib/planner/dag';
import { normalizeSkillSlugs, ProjectPlanner, renderTaskForEmbedding } from '@/lib/planner/planner';
import {
  PlannerRepositoryError,
  type ApplyPlanResult,
  type CreateProjectInput,
  type PersistableEdge,
  type PersistableTask,
  type PlannerRepository,
  type ProjectRecord,
  type TaskEmbedding,
} from '@/lib/planner/repository';
import type { SkillCatalogEntry } from '@/lib/planner/prompts';

// ---------------------------------------------------------------------------------------
// Dobles de prueba
// ---------------------------------------------------------------------------------------

interface PlanTaskInput {
  code: string;
  dependsOn?: string[];
  budgetShare?: number;
  requiredSkills?: string[];
  estimatedHours?: number;
}

function buildPlan(tasks: PlanTaskInput[]): Record<string, unknown> {
  return {
    title: 'Micrositio de captación con analítica',
    summary: 'Enfoque en tres fases: base técnica, contenido y medición del embudo.',
    tasks: tasks.map((task) => ({
      code: task.code,
      title: `Tarea ${task.code}`,
      description: 'Descripción con alcance suficiente para superar el mínimo del esquema.',
      acceptanceCriteria: [
        {
          id: 'AC-1',
          criterion: 'El entregable cumple lo acordado y es verificable por el AI Judge.',
          verification: 'Se comprueba abriendo el artefacto y contrastando con el criterio.',
        },
      ],
      requiredSkills: task.requiredSkills ?? ['frontend-react'],
      estimatedHours: task.estimatedHours ?? 8,
      budgetShare: task.budgetShare ?? 1 / tasks.length,
      priority: 3,
      dependsOn: task.dependsOn ?? [],
    })),
  };
}

class FakeRepository implements PlannerRepository {
  readonly applied: Array<{
    projectId: string;
    tasks: PersistableTask[];
    edges: PersistableEdge[];
    metadata: Record<string, unknown>;
  }> = [];
  readonly registeredSkills: string[][] = [];
  readonly savedEmbeddings: TaskEmbedding[] = [];
  /** Número de llamadas a applyPlan que deben fallar con SQLSTATE 23514. */
  dagViolationsLeft = 0;

  constructor(
    private readonly catalog: SkillCatalogEntry[] = [
      { slug: 'frontend-react', name: 'React', category: 'ingenieria' },
      { slug: 'design-ui', name: 'UI', category: 'diseno' },
    ],
    private readonly project: ProjectRecord = {
      id: 'p-1',
      ownerId: 'u-1',
      title: 'provisional',
      objective: 'Necesito un micrositio de captación con formulario y analítica.',
      status: 'planning',
      visibility: 'private',
      currency: 'USD',
      budgetTotal: 3000,
      deadline: null,
    },
  ) {}

  async fetchSkillCatalog(): Promise<SkillCatalogEntry[]> {
    return [...this.catalog];
  }

  async registerSkills(slugs: readonly string[]): Promise<number> {
    this.registeredSkills.push([...slugs]);
    return slugs.length;
  }

  async loadProject(projectId: string): Promise<ProjectRecord | null> {
    return projectId === this.project.id ? { ...this.project } : null;
  }

  async createProject(input: CreateProjectInput): Promise<ProjectRecord> {
    return { ...this.project, ownerId: input.ownerId, title: input.title, objective: input.objective };
  }

  async applyPlan(
    projectId: string,
    tasks: readonly PersistableTask[],
    edges: readonly PersistableEdge[],
    metadata: Record<string, unknown>,
  ): Promise<ApplyPlanResult> {
    if (this.dagViolationsLeft > 0) {
      this.dagViolationsLeft -= 1;
      throw new PlannerRepositoryError(
        'VEKTORA/PLANNER: aplicar el plan falló -> la dependencia cierra un ciclo',
        '23514',
      );
    }
    this.applied.push({ projectId, tasks: [...tasks], edges: [...edges], metadata });
    const taskIds: Record<string, string> = {};
    for (const task of tasks) taskIds[task.code] = `id-${task.code}`;
    return { projectId, taskCount: tasks.length, edgeCount: edges.length, taskIds };
  }

  async saveTaskEmbeddings(entries: readonly TaskEmbedding[]): Promise<number> {
    this.savedEmbeddings.push(...entries);
    return entries.length;
  }

  get lastApplied() {
    return this.applied[this.applied.length - 1];
  }
}

/** Devuelve los planes indicados en orden; `null` significa "agota los proveedores". */
function fakeAi(responses: Array<Record<string, unknown> | null>): {
  client: AiClient;
  calls: Array<{ schemaName: string | undefined }>;
} {
  const calls: Array<{ schemaName: string | undefined }> = [];
  let index = 0;

  const client = {
    async generateStructured(request: {
      schema: { parse: (value: unknown) => unknown };
      schemaName?: string;
    }): Promise<StructuredResponse<unknown>> {
      calls.push({ schemaName: request.schemaName });
      // Ojo con `??` aquí: `null` es un valor SIGNIFICATIVO (agotar proveedores), no un
      // hueco. Se indexa con límites explícitos y la última respuesta se repite.
      const slot = Math.min(index, responses.length - 1);
      const next = responses.length === 0 ? null : (responses[slot] ?? null);
      index += 1;

      if (next === null) {
        throw new AiExhaustedError([
          {
            provider: 'groq',
            model: 'llama-3.3-70b-versatile',
            attempt: 1,
            code: 'invalid_output',
            message: 'tasks.1.dependsOn.0: cierra un ciclo: T-01 → T-02 → T-01',
          },
        ]);
      }

      return {
        data: request.schema.parse(next),
        provider: 'groq',
        model: 'llama-3.3-70b-versatile',
        runId: 'run-1',
        attempts: 1,
        repairs: 0,
        fellBackFrom: null,
        usage: {},
        costUsd: 0,
        latencyMs: 10,
        schemaDegraded: false,
      };
    },
  } as unknown as AiClient;

  return { client, calls };
}

const noEmbeddings = null;

function fakeEmbeddings(dimensions = 4): EmbeddingService {
  return {
    dimensions,
    defaultTaskType: 'RETRIEVAL_DOCUMENT',
    isAvailable: () => true,
    describeModel: () => 'fake',
    async embedTexts({ texts }: { texts: string[] }) {
      return {
        vectors: texts.map((_, index) => Array.from({ length: dimensions }, (_, i) => (i + index) / 10)),
        model: 'gemini-embedding-001',
        dimensions,
        usage: {},
        costUsd: 0,
        latencyMs: 5,
        runId: null,
      };
    },
  } as unknown as EmbeddingService;
}

// ---------------------------------------------------------------------------------------

describe('camino feliz', () => {
  it('persiste un DAG correcto con orden topológico y presupuesto exacto', async () => {
    const repository = new FakeRepository();
    const { client } = fakeAi([
      buildPlan([
        { code: 'T-01', budgetShare: 0.4 },
        { code: 'T-02', dependsOn: ['T-01'], budgetShare: 0.3 },
        { code: 'T-03', dependsOn: ['T-01'], budgetShare: 0.2 },
        { code: 'T-04', dependsOn: ['T-02', 'T-03'], budgetShare: 0.1 },
      ]),
    ]);

    const planner = new ProjectPlanner({ repository, ai: client, embeddings: noEmbeddings });
    const result = await planner.planProject({
      create: { ownerId: 'u-1', objective: 'Micrositio de captación con analítica', budgetTotal: 3000 },
    });

    expect(result.taskCount).toBe(4);
    expect(result.edgeCount).toBe(4);
    expect(result.corrections).toEqual([]);
    expect(result.stats.criticalPath.path).toEqual(['T-01', 'T-02', 'T-04']);

    const applied = repository.lastApplied;
    expect(applied).toBeDefined();

    // order_index sigue el orden topológico: T-01 primero, T-04 al final.
    const byCode = new Map(applied?.tasks.map((task) => [task.code, task]));
    expect(byCode.get('T-01')?.order_index).toBe(1);
    expect(byCode.get('T-04')?.order_index).toBe(4);

    // Solo las raíces arrancan en `ready`.
    expect(byCode.get('T-01')?.status).toBe('ready');
    expect(byCode.get('T-02')?.status).toBe('blocked');

    // La suma de budgets coincide EXACTAMENTE con el total del proyecto.
    const total = (applied?.tasks ?? []).reduce((sum, task) => sum + (task.budget ?? 0), 0);
    expect(total).toBe(3000);

    // El título del planificador sustituye al provisional.
    expect(result.project.title).toBe('Micrositio de captación con analítica');
    expect(applied?.metadata['title']).toBe('Micrositio de captación con analítica');
  });

  it('el DAG persistido no contiene aristas inválidas', async () => {
    const repository = new FakeRepository();
    const { client } = fakeAi([
      buildPlan([{ code: 'T-01' }, { code: 'T-02', dependsOn: ['T-01'] }]),
    ]);
    const planner = new ProjectPlanner({ repository, ai: client, embeddings: noEmbeddings });
    await planner.planProject({ create: { ownerId: 'u-1', objective: 'Objetivo suficiente' } });

    expect(repository.lastApplied?.edges).toEqual([
      { task_code: 'T-02', depends_on_code: 'T-01' },
    ]);
  });
});

describe('capa 3: reparación determinista del grafo', () => {
  it('recurre al esquema laxo y rompe el ciclo cuando el modelo no lo corrige', async () => {
    const repository = new FakeRepository();
    const cyclic = buildPlan([
      { code: 'T-01', dependsOn: ['T-02'] },
      { code: 'T-02', dependsOn: ['T-01'] },
      { code: 'T-03', dependsOn: ['T-01'] },
    ]);
    // Primera llamada (esquema estricto) agota proveedores; la segunda acepta la forma.
    const { client, calls } = fakeAi([null, cyclic]);

    const planner = new ProjectPlanner({ repository, ai: client, embeddings: noEmbeddings });
    const result = await planner.planProject({
      create: { ownerId: 'u-1', objective: 'Objetivo suficiente para descomponer' },
    });

    expect(calls.map((call) => call.schemaName)).toEqual(['ProjectPlan', 'ProjectPlanShape']);
    expect(result.ai.strictSchema).toBe(false);
    expect(result.corrections.some((c) => c.kind === 'schema_fallback')).toBe(true);
    expect(result.corrections.some((c) => c.kind === 'broken_cycle')).toBe(true);

    const nodes = (repository.lastApplied?.tasks ?? []).map((task) => ({
      code: task.code,
      dependsOn: (repository.lastApplied?.edges ?? [])
        .filter((edge) => edge.task_code === task.code)
        .map((edge) => edge.depends_on_code),
    }));
    expect(isAcyclic(nodes)).toBe(true);
  });

  it('poda las referencias inválidas y lo deja auditado', async () => {
    const repository = new FakeRepository();
    const withGhost = buildPlan([
      { code: 'T-01' },
      { code: 'T-02', dependsOn: ['T-01', 'T-99'] },
    ]);
    const { client } = fakeAi([null, withGhost]);

    const planner = new ProjectPlanner({ repository, ai: client, embeddings: noEmbeddings });
    const result = await planner.planProject({
      create: { ownerId: 'u-1', objective: 'Objetivo suficiente para descomponer' },
    });

    expect(result.corrections.some((c) => c.kind === 'pruned_reference')).toBe(true);
    expect(repository.lastApplied?.edges).toEqual([
      { task_code: 'T-02', depends_on_code: 'T-01' },
    ]);
  });
});

describe('capa 4: el trigger de la base', () => {
  it('rompe ciclos y reintenta UNA vez ante SQLSTATE 23514', async () => {
    const repository = new FakeRepository();
    repository.dagViolationsLeft = 1;
    const { client } = fakeAi([
      buildPlan([{ code: 'T-01' }, { code: 'T-02', dependsOn: ['T-01'] }]),
    ]);

    const planner = new ProjectPlanner({ repository, ai: client, embeddings: noEmbeddings });
    const result = await planner.planProject({
      create: { ownerId: 'u-1', objective: 'Objetivo suficiente para descomponer' },
    });

    expect(result.corrections.some((c) => c.kind === 'dag_trigger_retry')).toBe(true);
    expect(repository.applied).toHaveLength(1);
  });

  it('un SEGUNDO rechazo se propaga en vez de reintentar en bucle', async () => {
    const repository = new FakeRepository();
    repository.dagViolationsLeft = 2;
    const { client } = fakeAi([
      buildPlan([{ code: 'T-01' }, { code: 'T-02', dependsOn: ['T-01'] }]),
    ]);

    const planner = new ProjectPlanner({ repository, ai: client, embeddings: noEmbeddings });
    await expect(
      planner.planProject({ create: { ownerId: 'u-1', objective: 'Objetivo suficiente' } }),
    ).rejects.toThrowError(PlannerRepositoryError);
  });
});

describe('catálogo de skills', () => {
  it('registra los slugs que no están en el catálogo', async () => {
    const repository = new FakeRepository();
    const { client } = fakeAi([
      buildPlan([
        { code: 'T-01', requiredSkills: ['frontend-react'] },
        { code: 'T-02', dependsOn: ['T-01'], requiredSkills: ['marketing-seo', 'design-ui'] },
      ]),
    ]);

    const planner = new ProjectPlanner({ repository, ai: client, embeddings: noEmbeddings });
    const result = await planner.planProject({
      create: { ownerId: 'u-1', objective: 'Objetivo suficiente para descomponer' },
    });

    expect(result.newSkills).toEqual(['marketing-seo']);
    expect(repository.registeredSkills).toEqual([['marketing-seo']]);
  });

  it('que falle el registro NO invalida el plan', async () => {
    const repository = new FakeRepository();
    vi.spyOn(repository, 'registerSkills').mockRejectedValue(new Error('permiso denegado'));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const { client } = fakeAi([
      buildPlan([
        { code: 'T-01', requiredSkills: ['skill-nueva'] },
        { code: 'T-02', dependsOn: ['T-01'] },
      ]),
    ]);

    const planner = new ProjectPlanner({ repository, ai: client, embeddings: noEmbeddings });
    const result = await planner.planProject({
      create: { ownerId: 'u-1', objective: 'Objetivo suficiente para descomponer' },
    });
    expect(result.taskCount).toBe(2);
  });
});

describe('embeddings de tareas', () => {
  it('vectoriza cada tarea persistida', async () => {
    const repository = new FakeRepository();
    const { client } = fakeAi([
      buildPlan([{ code: 'T-01' }, { code: 'T-02', dependsOn: ['T-01'] }]),
    ]);

    const planner = new ProjectPlanner({
      repository,
      ai: client,
      embeddings: fakeEmbeddings(4),
    });
    const result = await planner.planProject({
      create: { ownerId: 'u-1', objective: 'Objetivo suficiente para descomponer' },
    });

    expect(result.embeddedTasks).toBe(2);
    expect(repository.savedEmbeddings[0]?.taskId).toBe('id-T-01');
    // El vector viaja como literal de pgvector, no como array.
    expect(repository.savedEmbeddings[0]?.vector).toMatch(/^\[.+\]$/);
  });

  it('si fallan los embeddings el plan SIGUE guardado: se degrada, no se falla', async () => {
    const repository = new FakeRepository();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const broken = {
      isAvailable: () => true,
      async embedTexts() {
        throw new Error('429 desde Google');
      },
    } as unknown as EmbeddingService;

    const { client } = fakeAi([
      buildPlan([{ code: 'T-01' }, { code: 'T-02', dependsOn: ['T-01'] }]),
    ]);
    const planner = new ProjectPlanner({ repository, ai: client, embeddings: broken });
    const result = await planner.planProject({
      create: { ownerId: 'u-1', objective: 'Objetivo suficiente para descomponer' },
    });

    expect(result.embeddedTasks).toBe(0);
    expect(result.taskCount).toBe(2);
    expect(repository.applied).toHaveLength(1);
  });

  it('embedTasks:false salta la vectorización', async () => {
    const repository = new FakeRepository();
    const { client } = fakeAi([
      buildPlan([{ code: 'T-01' }, { code: 'T-02', dependsOn: ['T-01'] }]),
    ]);
    const planner = new ProjectPlanner({ repository, ai: client, embeddings: fakeEmbeddings() });
    const result = await planner.planProject({
      create: { ownerId: 'u-1', objective: 'Objetivo suficiente' },
      embedTasks: false,
    });
    expect(result.embeddedTasks).toBe(0);
  });
});

describe('validación de entrada', () => {
  let repository: FakeRepository;

  beforeEach(() => {
    repository = new FakeRepository();
  });

  it('exige projectId o create', async () => {
    const { client } = fakeAi([buildPlan([{ code: 'T-01' }, { code: 'T-02' }])]);
    const planner = new ProjectPlanner({ repository, ai: client, embeddings: noEmbeddings });
    await expect(planner.planProject({})).rejects.toThrowError(/projectId o create/);
  });

  it('rechaza un objetivo demasiado corto para descomponerlo', async () => {
    const { client } = fakeAi([buildPlan([{ code: 'T-01' }, { code: 'T-02' }])]);
    const planner = new ProjectPlanner({ repository, ai: client, embeddings: noEmbeddings });
    await expect(
      planner.planProject({ create: { ownerId: 'u-1', objective: 'corto' } }),
    ).rejects.toThrowError(/demasiado corto/);
  });

  it('falla si el proyecto a replanificar no existe', async () => {
    const { client } = fakeAi([buildPlan([{ code: 'T-01' }, { code: 'T-02' }])]);
    const planner = new ProjectPlanner({ repository, ai: client, embeddings: noEmbeddings });
    await expect(planner.planProject({ projectId: 'inexistente' })).rejects.toThrowError(/no existe/);
  });

  it('replanifica un proyecto existente', async () => {
    const { client } = fakeAi([
      buildPlan([{ code: 'T-01' }, { code: 'T-02', dependsOn: ['T-01'] }]),
    ]);
    const planner = new ProjectPlanner({ repository, ai: client, embeddings: noEmbeddings });
    const result = await planner.planProject({ projectId: 'p-1' });
    expect(result.project.id).toBe('p-1');
    expect(repository.applied).toHaveLength(1);
  });
});

describe('utilidades', () => {
  it('normalizeSkillSlugs deduplica, normaliza y descarta lo inválido', () => {
    expect(normalizeSkillSlugs(['Front End', 'front-end', '  SEO  ', '!!!', 'a--b'])).toEqual([
      'a-b',
      'front-end',
      'seo',
    ]);
  });

  it('el texto de embedding incluye skills y criterios', () => {
    const text = renderTaskForEmbedding({
      code: 'T-01',
      title: 'Maquetar la landing',
      description: 'Landing responsive',
      acceptanceCriteria: [{ id: 'AC-1', criterion: 'Pasa Lighthouse 90', verification: 'Informe' }],
      requiredSkills: ['frontend-css'],
      estimatedHours: 6,
      budgetShare: 0.5,
      priority: 2,
      dependsOn: [],
    });
    expect(text).toContain('frontend-css');
    expect(text).toContain('Pasa Lighthouse 90');
  });
});
