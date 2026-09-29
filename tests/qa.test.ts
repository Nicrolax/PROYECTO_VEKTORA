/**
 * Orquestación del AI Judge con IA y repositorio falsos.
 *
 * Lo que se protege aquí no es el camino feliz, sino los tres modos de fallo que
 * convertirían al juez en un peligro: aprobar sin evidencia, rechazar por una avería
 * nuestra, y dejar un entregable bloqueado en `running` para siempre.
 */

import { describe, expect, it } from 'vitest';
import { AiExhaustedError } from '@/lib/ai/errors';
import type { AiClient, StructuredResponse } from '@/lib/ai/ai-client';
import { loadQaConfig } from '@/lib/qa/config';
import { QaJudge } from '@/lib/qa/judge';
import { buildQaVerdictSchema } from '@/lib/qa/schemas';
import type {
  ApplyVerdictInput,
  ApplyVerdictResult,
  PendingDeliverable,
  QaClaim,
  QaClaimResult,
  QaReleaseStatus,
  QaRepository,
} from '@/lib/qa/repository';

const config = loadQaConfig({});

const CRITERIA = [
  { id: 'AC-1', criterion: 'Incluye objetivos medibles', verification: 'Se leen los objetivos' },
  { id: 'AC-2', criterion: 'Lista lo que queda fuera', verification: 'Se busca la sección' },
];

function claim(overrides: Partial<QaClaim> = {}): QaClaim {
  return {
    deliverable: {
      id: 'd-1',
      taskId: 't-1',
      providerId: 'u-1',
      version: 1,
      summary: 'Documento de alcance',
      content: 'Objetivos, entregables y exclusiones.',
      artifacts: [],
      evidence: { 'AC-1': 'Sección 2', 'AC-2': 'Sección 5' },
      submittedAt: '2026-01-01T00:00:00Z',
      ...overrides.deliverable,
    },
    task: {
      id: 't-1',
      projectId: 'p-1',
      code: 'T-01',
      title: 'Redactar el alcance',
      description: 'Alcance del proyecto',
      acceptanceCriteria: CRITERIA,
      requiredSkills: ['technical-writing'],
      status: 'submitted',
      assigneeId: 'u-1',
      budget: 300,
      estimatedHours: 8,
      ...overrides.task,
    },
    project: { id: 'p-1', title: 'Proyecto', objective: 'Objetivo', ...overrides.project },
    previousStatus: overrides.previousStatus ?? 'pending',
    previousRejections: overrides.previousRejections ?? 0,
  };
}

class FakeRepository implements QaRepository {
  readonly released: Array<{ status: QaReleaseStatus; error: string | null }> = [];
  readonly applications: ApplyVerdictInput[] = [];
  claimResult: QaClaimResult;
  applyResult: ApplyVerdictResult = {
    applied: true,
    reason: null,
    reviewId: 'r-1',
    reputationWritten: 2,
    reputationSkipped: [],
  };
  applyThrows: Error | null = null;

  constructor(claimed: QaClaim | null = claim()) {
    this.claimResult =
      claimed === null
        ? { claimed: false, reason: 'ya fue aprobado', qaStatus: 'approved', claim: null }
        : { claimed: true, reason: null, qaStatus: 'running', claim: claimed };
  }

  async claim(): Promise<QaClaimResult> {
    return this.claimResult;
  }

  async release(_id: string, status: QaReleaseStatus, error: string | null): Promise<boolean> {
    this.released.push({ status, error });
    return true;
  }

  async applyVerdict(input: ApplyVerdictInput): Promise<ApplyVerdictResult> {
    if (this.applyThrows !== null) throw this.applyThrows;
    this.applications.push(input);
    return this.applyResult;
  }

  async pending(): Promise<PendingDeliverable[]> {
    return [];
  }

  async latestDeliverableForTask(): Promise<string | null> {
    return 'd-1';
  }
}

/** IA falsa. `null` significa "agota los proveedores". */
function fakeAi(payload: Record<string, unknown> | null): { client: AiClient; calls: number[] } {
  const calls: number[] = [];
  const client = {
    async generateStructured(request: {
      schema: { parse: (value: unknown) => unknown };
    }): Promise<StructuredResponse<unknown>> {
      calls.push(1);
      if (payload === null) {
        throw new AiExhaustedError([
          {
            provider: 'groq',
            model: 'openai/gpt-oss-120b',
            attempt: 1,
            code: 'rate_limit',
            message: '429 cuota diaria agotada',
          },
        ]);
      }
      return {
        data: request.schema.parse(payload),
        provider: 'groq',
        model: 'openai/gpt-oss-120b',
        runId: 'run-qa-1',
        attempts: 1,
        repairs: 0,
        fellBackFrom: null,
        usage: {},
        costUsd: 0,
        latencyMs: 12,
        schemaDegraded: false,
      };
    },
  } as unknown as AiClient;
  return { client, calls };
}

function verdicts(outcomes: Array<'pass' | 'fail' | 'unverifiable'>): Record<string, unknown> {
  return {
    criteria: outcomes.map((outcome, index) => ({
      id: `AC-${index + 1}`,
      verdict: outcome,
      confidence: 0.9,
      evidence: 'Sección citada del entregable',
      reasoning: 'La evidencia responde a lo que pide el criterio de aceptación.',
    })),
    summary: 'Resumen accionable para el proveedor con longitud suficiente.',
    blockingIssues: outcomes.includes('pass') && !outcomes.includes('fail') ? [] : ['Falta AC-2'],
  };
}

// -----------------------------------------------------------------------------------------

describe('camino feliz', () => {
  it('aprueba, escribe el veredicto y adjunta el run de telemetría', async () => {
    const repository = new FakeRepository();
    const { client, calls } = fakeAi(verdicts(['pass', 'pass']));
    const result = await new QaJudge({ repository, ai: client, config }).judge({
      deliverableId: 'd-1',
    });

    expect(calls).toHaveLength(1);
    expect(result.judged).toBe(true);
    expect(result.decision?.qaStatus).toBe('approved');
    expect(repository.applications).toHaveLength(1);
    expect(repository.applications[0]?.taskStatus).toBe('approved');
    expect(repository.applications[0]?.runId).toBe('run-qa-1');
    // El veredicto por criterio se persiste entero: sin eso no se puede auditar después.
    expect(repository.applications[0]?.criteriaResults).toHaveLength(2);
  });
});

describe('el juez no aprueba lo que no puede comprobar', () => {
  it('un entregable vacío se resuelve SIN llamar al modelo', async () => {
    const repository = new FakeRepository(
      claim({
        deliverable: {
          ...claim().deliverable,
          summary: null,
          content: null,
          artifacts: [],
          evidence: {},
        },
      }),
    );
    const { client, calls } = fakeAi(verdicts(['pass', 'pass']));
    const result = await new QaJudge({ repository, ai: client, config }).judge({
      deliverableId: 'd-1',
    });

    expect(calls).toHaveLength(0);
    expect(result.skippedAi).toBe(true);
    expect(result.decision?.qaStatus).toBe('revision_requested');
    expect(repository.applications[0]?.score).toBe(0);
  });

  it('una tarea sin criterios interpretables no se aprueba', async () => {
    const repository = new FakeRepository(
      claim({ task: { ...claim().task, acceptanceCriteria: [{ roto: true }] } }),
    );
    const { client, calls } = fakeAi(verdicts(['pass', 'pass']));
    const result = await new QaJudge({ repository, ai: client, config }).judge({
      deliverableId: 'd-1',
    });

    expect(calls).toHaveLength(0);
    expect(result.malformedCriteria).toBe(1);
    expect(result.decision?.qaStatus).toBe('revision_requested');
  });
});

describe('una avería nuestra no es un rechazo', () => {
  it('si la IA se agota, el entregable vuelve a "error" y NADIE pierde reputación', async () => {
    const repository = new FakeRepository();
    const { client } = fakeAi(null);
    const result = await new QaJudge({ repository, ai: client, config }).judge({
      deliverableId: 'd-1',
    });

    expect(result.judged).toBe(false);
    expect(result.reason).toContain('no pudo evaluar');
    expect(repository.applications).toHaveLength(0);
    expect(repository.released).toEqual([
      { status: 'error', error: expect.stringContaining('429') as unknown as string },
    ]);
  });

  it('si la escritura del veredicto falla, el turno se suelta igual', async () => {
    // El peor final posible sería dejarlo en `running`: ningún juez volvería a tomarlo.
    const repository = new FakeRepository();
    repository.applyThrows = new Error('la base se cayó a mitad');
    const { client } = fakeAi(verdicts(['pass', 'pass']));

    await expect(
      new QaJudge({ repository, ai: client, config }).judge({ deliverableId: 'd-1' }),
    ).rejects.toThrow(/la base se cayó/);
    expect(repository.released[0]?.status).toBe('error');
  });
});

describe('turno y concurrencia', () => {
  it('si no se pudo tomar el entregable, no se llama al modelo', async () => {
    const repository = new FakeRepository(null);
    const { client, calls } = fakeAi(verdicts(['pass', 'pass']));
    const result = await new QaJudge({ repository, ai: client, config }).judge({
      deliverableId: 'd-1',
    });

    expect(calls).toHaveLength(0);
    expect(result.judged).toBe(false);
    expect(result.reason).toContain('aprobado');
    expect(repository.released).toHaveLength(0);
  });

  it('si otro proceso resolvió el entregable antes, se informa y no se inventa nada', async () => {
    const repository = new FakeRepository();
    repository.applyResult = {
      applied: false,
      reason: 'el entregable no estaba en qa_status=running',
      reviewId: null,
      reputationWritten: 0,
      reputationSkipped: [],
    };
    const { client } = fakeAi(verdicts(['pass', 'pass']));
    const result = await new QaJudge({ repository, ai: client, config }).judge({
      deliverableId: 'd-1',
    });

    expect(result.judged).toBe(false);
    expect(result.reason).toContain('running');
  });

  it('el ensayo devuelve el entregable a su estado ANTERIOR, no a pending', async () => {
    const repository = new FakeRepository(claim({ previousStatus: 'revision_requested' }));
    const { client } = fakeAi(verdicts(['pass', 'pass']));
    const result = await new QaJudge({ repository, ai: client, config }).judge({
      deliverableId: 'd-1',
      dryRun: true,
    });

    expect(result.judged).toBe(true);
    expect(result.decision?.qaStatus).toBe('approved');
    expect(repository.applications).toHaveLength(0);
    expect(repository.released).toEqual([{ status: 'revision_requested', error: null }]);
  });
});

describe('contrato de salida del modelo', () => {
  const schema = buildQaVerdictSchema(['AC-1', 'AC-2']);

  it('falta un criterio -> error accionable para el bucle de auto-reparación', () => {
    const result = schema.safeParse(verdicts(['pass']));
    expect(result.success).toBe(false);
    const messages = result.success ? [] : result.error.issues.map((issue) => issue.message);
    expect(messages.join(' ')).toContain('falta el veredicto de AC-2');
  });

  it('un criterio inventado se rechaza nombrando los válidos', () => {
    const payload = verdicts(['pass', 'pass']) as { criteria: Array<{ id: string }> };
    payload.criteria[1] = { ...payload.criteria[1], id: 'AC-9' } as { id: string };
    const result = schema.safeParse(payload);
    expect(result.success).toBe(false);
    const messages = result.success ? [] : result.error.issues.map((issue) => issue.message);
    expect(messages.join(' ')).toContain('AC-1, AC-2');
  });

  it('un pass sin evidencia citada no valida', () => {
    const payload = verdicts(['pass', 'pass']) as { criteria: Array<{ evidence: string }> };
    payload.criteria[0] = { ...payload.criteria[0], evidence: '' } as { evidence: string };
    expect(schema.safeParse(payload).success).toBe(false);
  });

  it('el mismo criterio dos veces se rechaza', () => {
    const payload = verdicts(['pass', 'pass']) as { criteria: Array<{ id: string }> };
    payload.criteria[1] = { ...payload.criteria[1], id: 'AC-1' } as { id: string };
    const result = schema.safeParse(payload);
    expect(result.success).toBe(false);
  });
});
