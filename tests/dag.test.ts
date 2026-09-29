/**
 * Álgebra de grafos del planificador. Es el módulo donde un error es más caro y más
 * silencioso: un ciclo no detectado sale como SQLSTATE 23514 en producción, y una ruta
 * crítica mal calculada falsea la planificación entera sin que nada falle.
 */

import { describe, expect, it } from 'vitest';
import {
  breakCycles,
  computeDepths,
  criticalPath,
  describeDag,
  executionLevels,
  findCycles,
  findDuplicateCodes,
  findReferenceProblems,
  formatCycle,
  isAcyclic,
  leafCodes,
  pruneInvalidReferences,
  rootCodes,
  toEdges,
  topologicalSort,
  type DagNode,
} from '@/lib/planner/dag';

const node = (code: string, dependsOn: string[] = [], weight?: number): DagNode =>
  weight === undefined ? { code, dependsOn } : { code, dependsOn, weight };

/** Diamante: T-01 -> (T-02 | T-03) -> T-04. */
const diamond: DagNode[] = [
  node('T-01', [], 4),
  node('T-02', ['T-01'], 6),
  node('T-03', ['T-01'], 10),
  node('T-04', ['T-02', 'T-03'], 2),
];

describe('detección de ciclos', () => {
  it('un grafo acíclico no tiene ciclos', () => {
    expect(findCycles(diamond)).toEqual([]);
    expect(isAcyclic(diamond)).toBe(true);
  });

  it('detecta un ciclo de dos nodos', () => {
    const cycles = findCycles([node('T-01', ['T-02']), node('T-02', ['T-01'])]);
    expect(cycles).toHaveLength(1);
    expect(cycles[0]).toEqual(['T-01', 'T-02']);
  });

  it('detecta un ciclo de tres nodos y lo normaliza al código menor', () => {
    const cycles = findCycles([
      node('T-02', ['T-03']),
      node('T-03', ['T-01']),
      node('T-01', ['T-02']),
    ]);
    expect(cycles).toHaveLength(1);
    expect(cycles[0]?.[0]).toBe('T-01');
  });

  it('detecta varios ciclos disjuntos', () => {
    const cycles = findCycles([
      node('T-01', ['T-02']),
      node('T-02', ['T-01']),
      node('T-03', ['T-04']),
      node('T-04', ['T-03']),
      node('T-05', []),
    ]);
    expect(cycles).toHaveLength(2);
  });

  it('la auto-dependencia es un ciclo de longitud 1', () => {
    expect(findCycles([node('T-01', ['T-01'])])).toEqual([['T-01']]);
  });

  it('ignora las referencias a códigos inexistentes', () => {
    expect(findCycles([node('T-01', ['T-99'])])).toEqual([]);
  });

  it('la salida es determinista entre ejecuciones', () => {
    const graph = [
      node('T-03', ['T-01']),
      node('T-01', ['T-02']),
      node('T-02', ['T-03']),
    ];
    const first = JSON.stringify(findCycles(graph));
    for (let i = 0; i < 20; i += 1) {
      expect(JSON.stringify(findCycles(graph))).toBe(first);
    }
  });

  it('formatCycle cierra el ciclo sobre su primer nodo', () => {
    expect(formatCycle(['T-01', 'T-02'])).toBe('T-01 → T-02 → T-01');
    expect(formatCycle([])).toBe('');
  });
});

describe('problemas de referencia', () => {
  it('encuentra códigos duplicados', () => {
    expect(findDuplicateCodes([node('T-01'), node('T-01'), node('T-02')])).toEqual(['T-01']);
  });

  it('clasifica auto-referencia, referencia desconocida y duplicado', () => {
    const problems = findReferenceProblems([
      node('T-01', ['T-01']),
      node('T-02', ['T-99']),
      node('T-03', ['T-01', 'T-01']),
    ]);
    expect(problems.map((problem) => problem.kind)).toEqual(['self', 'unknown', 'duplicate']);
    expect(problems[2]?.index).toBe(1);
  });
});

describe('orden topológico', () => {
  it('respeta las dependencias y desempata alfabéticamente', () => {
    const { order, unresolved } = topologicalSort(diamond);
    expect(order).toEqual(['T-01', 'T-02', 'T-03', 'T-04']);
    expect(unresolved).toEqual([]);
  });

  it('deja fuera los nodos atrapados en un ciclo', () => {
    const { order, unresolved } = topologicalSort([
      node('T-01', []),
      node('T-02', ['T-03']),
      node('T-03', ['T-02']),
    ]);
    expect(order).toEqual(['T-01']);
    expect(unresolved).toEqual(['T-02', 'T-03']);
  });

  it('un replan del mismo grafo produce el mismo orden', () => {
    const shuffled = [...diamond].reverse();
    expect(topologicalSort(shuffled).order).toEqual(topologicalSort(diamond).order);
  });
});

describe('profundidad, niveles y ruta crítica', () => {
  it('la profundidad es el camino MÁS LARGO desde una raíz', () => {
    const depths = computeDepths([
      node('T-01', []),
      node('T-02', ['T-01']),
      node('T-03', ['T-01', 'T-02']),
    ]);
    expect(depths.get('T-01')).toBe(0);
    expect(depths.get('T-02')).toBe(1);
    // Por T-01 sería 1, por T-02 es 2: manda el camino más largo.
    expect(depths.get('T-03')).toBe(2);
  });

  it('los nodos en ciclo reciben profundidad 0 y no rompen el insert', () => {
    const depths = computeDepths([node('T-01', ['T-02']), node('T-02', ['T-01'])]);
    expect(depths.get('T-01')).toBe(0);
    expect(depths.get('T-02')).toBe(0);
  });

  it('la ruta crítica sigue el mayor peso acumulado', () => {
    const path = criticalPath(diamond);
    expect(path.path).toEqual(['T-01', 'T-03', 'T-04']);
    expect(path.totalWeight).toBe(16);
  });

  it('los niveles agrupan lo paralelizable', () => {
    expect(executionLevels(diamond)).toEqual([['T-01'], ['T-02', 'T-03'], ['T-04']]);
  });

  it('raíces y hojas', () => {
    expect(rootCodes(diamond)).toEqual(['T-01']);
    expect(leafCodes(diamond)).toEqual(['T-04']);
  });

  it('describeDag resume el grafo completo', () => {
    const stats = describeDag(diamond);
    expect(stats.taskCount).toBe(4);
    expect(stats.edgeCount).toBe(4);
    expect(stats.depth).toBe(3);
    expect(stats.criticalPath.totalWeight).toBe(16);
  });

  it('toEdges aplana en la dirección task -> dependsOn', () => {
    expect(toEdges([node('T-02', ['T-01'])])).toEqual([{ from: 'T-02', to: 'T-01' }]);
  });
});

describe('reparación determinista', () => {
  it('pruneInvalidReferences quita self, desconocidas y duplicadas', () => {
    const result = pruneInvalidReferences([
      node('T-01', ['T-01', 'T-99']),
      node('T-02', ['T-01', 'T-01']),
    ]);
    expect(result.nodes[0]?.dependsOn).toEqual([]);
    expect(result.nodes[1]?.dependsOn).toEqual(['T-01']);
    expect(result.removed).toHaveLength(3);
  });

  it('breakCycles deja el grafo acíclico', () => {
    const result = breakCycles([
      node('T-01', ['T-02']),
      node('T-02', ['T-03']),
      node('T-03', ['T-01']),
    ]);
    expect(isAcyclic(result.nodes)).toBe(true);
    expect(result.removed).toHaveLength(1);
  });

  it('corta la arista del código MAYOR al siguiente del ciclo', () => {
    const result = breakCycles([node('T-01', ['T-02']), node('T-02', ['T-01'])]);
    expect(result.removed[0]).toMatchObject({ from: 'T-02', to: 'T-01' });
  });

  it('resuelve un grafo completamente cíclico de 5 nodos', () => {
    const complete: DagNode[] = ['T-01', 'T-02', 'T-03', 'T-04', 'T-05'].map((code, _i, all) =>
      node(code, all.filter((other) => other !== code)),
    );
    const result = breakCycles(complete);
    expect(isAcyclic(result.nodes)).toBe(true);
    expect(result.removed.length).toBeGreaterThan(0);
  });

  it('es determinista: dos ejecuciones producen el mismo grafo', () => {
    const graph = [
      node('T-01', ['T-03']),
      node('T-02', ['T-01']),
      node('T-03', ['T-02']),
    ];
    expect(JSON.stringify(breakCycles(graph))).toBe(JSON.stringify(breakCycles(graph)));
  });

  it('no toca un grafo que ya es acíclico', () => {
    const result = breakCycles(diamond);
    expect(result.removed).toEqual([]);
    expect(result.nodes).toEqual(diamond);
  });
});
