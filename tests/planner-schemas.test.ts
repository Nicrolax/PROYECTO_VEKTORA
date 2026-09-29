/**
 * Contrato Zod del plan. La decisión central de la FASE 3 es que los invariantes del DAG
 * son refinements: si un refinement deja de dispararse, el bucle de auto-reparación de la
 * FASE 2 no recibe nada que corregir y el grafo inválido llega hasta el trigger de la base.
 * Cada prueba de aquí protege un refinement concreto.
 */

import { describe, expect, it } from 'vitest';
import {
  AcceptanceCriterionSchema,
  ProjectPlanSchema,
  ProjectPlanShapeSchema,
  SKILL_SLUG_RE,
  TASK_CODE_RE,
} from '@/lib/planner/schemas';

interface TaskOverrides {
  code?: string;
  dependsOn?: string[];
  budgetShare?: number;
  requiredSkills?: string[];
  acceptanceCriteria?: Array<{ id: string; criterion: string; verification: string }>;
}

function task(code: string, overrides: TaskOverrides = {}): Record<string, unknown> {
  return {
    code: overrides.code ?? code,
    title: `Tarea ${code}`,
    description: 'Descripción con alcance suficiente para superar el mínimo del esquema.',
    acceptanceCriteria: overrides.acceptanceCriteria ?? [
      {
        id: 'AC-1',
        criterion: 'El entregable incluye el artefacto acordado y es verificable.',
        verification: 'Se comprueba abriendo el artefacto y contrastando con el criterio.',
      },
    ],
    requiredSkills: overrides.requiredSkills ?? ['frontend-react'],
    estimatedHours: 8,
    budgetShare: overrides.budgetShare ?? 0.5,
    priority: 3,
    dependsOn: overrides.dependsOn ?? [],
  };
}

function plan(tasks: Array<Record<string, unknown>>): Record<string, unknown> {
  return {
    title: 'Plan de prueba de VEKTORA',
    summary: 'Resumen del enfoque con longitud suficiente para el esquema estricto.',
    tasks,
  };
}

/** Mensajes de todos los issues, para aserciones legibles. */
function issues(value: unknown): string[] {
  const result = ProjectPlanSchema.safeParse(value);
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
}

describe('expresiones regulares del contrato', () => {
  it('TASK_CODE_RE acepta T-01 y la subtarea T-01.1', () => {
    for (const code of ['T-01', 'T-24', 'T-03.1', 'T-03.12']) {
      expect(TASK_CODE_RE.test(code)).toBe(true);
    }
    for (const code of ['T-1', 'X-01', 'T-011', 't-01', 'T-01.']) {
      expect(TASK_CODE_RE.test(code)).toBe(false);
    }
  });

  it('SKILL_SLUG_RE solo admite minúsculas, dígitos y guiones simples', () => {
    for (const slug of ['frontend-react', 'seo', 'web3-solidity']) {
      expect(SKILL_SLUG_RE.test(slug)).toBe(true);
    }
    for (const slug of ['Frontend', 'front--end', '-seo', 'seo-', 'front end']) {
      expect(SKILL_SLUG_RE.test(slug)).toBe(false);
    }
  });
});

describe('plan válido', () => {
  it('acepta un DAG correcto con budgetShare que suma 1', () => {
    const result = ProjectPlanSchema.safeParse(
      plan([task('T-01'), task('T-02', { dependsOn: ['T-01'] })]),
    );
    expect(result.success).toBe(true);
  });
});

describe('refinements del grafo', () => {
  it('rechaza códigos duplicados', () => {
    const messages = issues(plan([task('T-01'), task('T-01')]));
    expect(messages.some((message) => message.includes('repetido'))).toBe(true);
  });

  it('rechaza una referencia a una tarea inexistente', () => {
    const messages = issues(plan([task('T-01'), task('T-02', { dependsOn: ['T-09'] })]));
    expect(messages.some((message) => message.includes('no corresponde a ninguna tarea'))).toBe(true);
  });

  it('rechaza la auto-dependencia', () => {
    const messages = issues(plan([task('T-01', { dependsOn: ['T-01'] }), task('T-02')]));
    expect(messages.some((message) => message.includes('depender de sí misma'))).toBe(true);
  });

  it('rechaza una dependencia duplicada', () => {
    const messages = issues(
      plan([task('T-01'), task('T-02', { dependsOn: ['T-01', 'T-01'] })]),
    );
    expect(messages.some((message) => message.includes('dos veces'))).toBe(true);
  });

  it('rechaza un ciclo y describe la ruta en el mensaje', () => {
    const messages = issues(
      plan([task('T-01', { dependsOn: ['T-02'] }), task('T-02', { dependsOn: ['T-01'] })]),
    );
    const cycle = messages.find((message) => message.includes('cierra un ciclo'));
    expect(cycle).toBeDefined();
    // El mensaje tiene que ser accionable: es lo que se le devuelve al modelo.
    expect(cycle).toContain('T-01 → T-02 → T-01');
  });

  it('el issue del ciclo apunta a la dependencia concreta, no al objeto entero', () => {
    const result = ProjectPlanSchema.safeParse(
      plan([task('T-01', { dependsOn: ['T-02'] }), task('T-02', { dependsOn: ['T-01'] })]),
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    const cycle = result.error.issues.find((issue) => issue.message.includes('cierra un ciclo'));
    expect(cycle?.path.join('.')).toMatch(/^tasks\.\d+\.dependsOn\.\d+$/);
  });

  it('exige al menos una raíz', () => {
    const messages = issues(
      plan([
        task('T-01', { dependsOn: ['T-02'] }),
        task('T-02', { dependsOn: ['T-03'] }),
        task('T-03', { dependsOn: ['T-01'] }),
      ]),
    );
    expect(messages.some((message) => message.includes('dependsOn vacío'))).toBe(true);
  });
});

describe('presupuesto y criterios', () => {
  it('rechaza que budgetShare no sume 1', () => {
    const messages = issues(
      plan([task('T-01', { budgetShare: 0.2 }), task('T-02', { budgetShare: 0.2 })]),
    );
    expect(messages.some((message) => message.includes('budgetShare'))).toBe(true);
  });

  it('acepta una desviación dentro de la tolerancia', () => {
    const result = ProjectPlanSchema.safeParse(
      plan([task('T-01', { budgetShare: 0.49 }), task('T-02', { budgetShare: 0.5 })]),
    );
    expect(result.success).toBe(true);
  });

  it('rechaza identificadores de criterio repetidos dentro de una tarea', () => {
    const duplicated = [
      {
        id: 'AC-1',
        criterion: 'Primer criterio verificable con longitud suficiente.',
        verification: 'Se comprueba revisando el artefacto entregado.',
      },
      {
        id: 'AC-1',
        criterion: 'Segundo criterio verificable con longitud suficiente.',
        verification: 'Se comprueba revisando el artefacto entregado.',
      },
    ];
    const messages = issues(
      plan([task('T-01', { acceptanceCriteria: duplicated }), task('T-02')]),
    );
    expect(messages.some((message) => message.includes('AC-1'))).toBe(true);
  });
});

describe('esquema estricto', () => {
  it('rechaza propiedades no declaradas', () => {
    const invalid = plan([task('T-01'), task('T-02')]);
    (invalid as Record<string, unknown>)['extra'] = true;
    expect(ProjectPlanSchema.safeParse(invalid).success).toBe(false);
  });

  it('exige al menos 2 tareas', () => {
    expect(ProjectPlanSchema.safeParse(plan([task('T-01')])).success).toBe(false);
  });
});

describe('ProjectPlanShapeSchema (último recurso)', () => {
  it('acepta un grafo cíclico para poder repararlo de forma determinista', () => {
    const cyclic = plan([
      task('T-01', { dependsOn: ['T-02'] }),
      task('T-02', { dependsOn: ['T-01'] }),
    ]);
    expect(ProjectPlanSchema.safeParse(cyclic).success).toBe(false);
    expect(ProjectPlanShapeSchema.safeParse(cyclic).success).toBe(true);
  });

  it('pero sigue exigiendo la forma básica de cada tarea', () => {
    const malformed = plan([task('T-01'), { ...task('T-02'), estimatedHours: -3 }]);
    expect(ProjectPlanShapeSchema.safeParse(malformed).success).toBe(false);
  });
});

describe('criterios que ninguna máquina puede cumplir', () => {
  // Salió de un proyecto real: el planificador escribió «Aprobado por el cliente mediante
  // firma digital» en la tarea RAÍZ del grafo. Nadie podía cumplirlo, así que esa tarea
  // estaba condenada — y con ella las otras nueve, bloqueadas para siempre. Un criterio mal
  // escrito paró el proyecto entero, que es exactamente lo que la regla 1 prohíbe.
  const bloqueantes = [
    'Aprobado por el cliente mediante firma digital',
    'El documento cuenta con el visto bueno del responsable de marketing',
    'Validado por el stakeholder principal antes de publicarse',
    'Requiere sign-off del propietario del producto',
    'Approved by the client before deployment',
  ];

  for (const criterion of bloqueantes) {
    it(`rechaza: "${criterion}"`, () => {
      const result = AcceptanceCriterionSchema.safeParse({
        id: 'AC-1',
        criterion,
        verification: 'Se comprueba abriendo el documento entregado.',
      });
      expect(result.success).toBe(false);
      const messages = result.success ? [] : result.error.issues.map((issue) => issue.message);
      expect(messages.join(' ')).toContain('no tiene intervención humana');
    });
  }

  it('también lo detecta en `verification`, no solo en el criterio', () => {
    const result = AcceptanceCriterionSchema.safeParse({
      id: 'AC-1',
      criterion: 'El documento incluye la sección de conformidad con sus tres campos.',
      verification: 'Se confirma con el visto bueno del cliente.',
    });
    expect(result.success).toBe(false);
  });

  const validos = [
    'El PDF incluye una sección de conformidad con fecha, alcance y firmante para rellenar',
    'El informe describe el flujo de aprobación interno en un diagrama de tres pasos',
    'Las notas de las entrevistas con usuarios están transcritas en el anexo B',
    'El logo entregado incluye la firma de la marca en su variante horizontal',
  ];

  for (const criterion of validos) {
    it(`acepta: "${criterion.slice(0, 48)}…"`, () => {
      // El texto habla DE una aprobación o una firma, pero su cumplimiento se comprueba
      // mirando el entregable. Un falso positivo aquí cuesta una ronda de reparación.
      const result = AcceptanceCriterionSchema.safeParse({
        id: 'AC-1',
        criterion,
        verification: 'Se comprueba abriendo el artefacto entregado y localizando la sección.',
      });
      expect(result.success).toBe(true);
    });
  }
});
