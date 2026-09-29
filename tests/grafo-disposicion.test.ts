/**
 * Disposición del grafo. Módulo puro y, por tanto, el único de la interfaz que se puede
 * probar sin navegador. Lo que se protege aquí es que el dibujo SIGNIFIQUE algo: la columna
 * de una tarea es su profundidad real en el grafo, no una posición estética.
 */

import { describe, expect, it } from 'vitest';
import {
  ALTO_NODO,
  ANCHO_NODO,
  contarPorEstado,
  disponerGrafo,
  type TareaGrafo,
} from '@/components/grafo/disposicion';

function tarea(code: string, dependsOn: string[] = [], status = 'blocked'): TareaGrafo {
  return {
    id: `id-${code}`,
    code,
    title: `Tarea ${code}`,
    status,
    dependsOn,
    assigneeId: null,
    budget: 100,
  };
}

describe('disponerGrafo', () => {
  it('un grafo vacío no rompe', () => {
    const disposicion = disponerGrafo([]);
    expect(disposicion.nodos).toEqual([]);
    expect(disposicion.ancho).toBe(0);
  });

  it('la columna de una tarea es su profundidad en el grafo', () => {
    const disposicion = disponerGrafo([
      tarea('T-01'),
      tarea('T-02', ['T-01']),
      tarea('T-03', ['T-02']),
    ]);
    const porCodigo = new Map(disposicion.nodos.map((n) => [n.code, n]));
    expect(porCodigo.get('T-01')?.nivel).toBe(0);
    expect(porCodigo.get('T-02')?.nivel).toBe(1);
    expect(porCodigo.get('T-03')?.nivel).toBe(2);
    // Y la profundidad se traduce en posición horizontal creciente.
    expect(porCodigo.get('T-01')!.x).toBeLessThan(porCodigo.get('T-02')!.x);
    expect(porCodigo.get('T-02')!.x).toBeLessThan(porCodigo.get('T-03')!.x);
  });

  it('las tareas independientes comparten columna y no se solapan', () => {
    const disposicion = disponerGrafo([tarea('T-01'), tarea('T-02'), tarea('T-03')]);
    expect(new Set(disposicion.nodos.map((n) => n.nivel))).toEqual(new Set([0]));

    const ys = disposicion.nodos.map((n) => n.y).sort((a, b) => a - b);
    for (let i = 1; i < ys.length; i += 1) {
      expect(ys[i]! - ys[i - 1]!).toBeGreaterThanOrEqual(ALTO_NODO);
    }
  });

  it('una tarea con varias dependencias se coloca tras la MÁS profunda', () => {
    const disposicion = disponerGrafo([
      tarea('T-01'),
      tarea('T-02', ['T-01']),
      tarea('T-03', ['T-01', 'T-02']),
    ]);
    const porCodigo = new Map(disposicion.nodos.map((n) => [n.code, n]));
    expect(porCodigo.get('T-03')?.nivel).toBe(2);
  });

  it('dibuja una arista por dependencia, de derecha a izquierda del nodo origen', () => {
    const disposicion = disponerGrafo([tarea('T-01'), tarea('T-02', ['T-01'])]);
    expect(disposicion.aristas).toHaveLength(1);
    const arista = disposicion.aristas[0]!;
    expect(arista.desde).toBe('T-01');
    expect(arista.hasta).toBe('T-02');
    expect(arista.trazo.startsWith('M ')).toBe(true);
  });

  it('marca como satisfecha la arista cuyo origen está aprobado', () => {
    const disposicion = disponerGrafo([
      tarea('T-01', [], 'approved'),
      tarea('T-02', ['T-01'], 'ready'),
      tarea('T-03', ['T-02'], 'blocked'),
    ]);
    const porDestino = new Map(disposicion.aristas.map((a) => [a.hasta, a]));
    expect(porDestino.get('T-02')?.satisfecha).toBe(true);
    expect(porDestino.get('T-03')?.satisfecha).toBe(false);
  });

  it('ignora una dependencia que apunta a una tarea inexistente', () => {
    // No debería ocurrir —el planificador valida las referencias— pero el visualizador no
    // puede caerse por un dato heredado.
    const disposicion = disponerGrafo([tarea('T-02', ['T-99'])]);
    expect(disposicion.aristas).toEqual([]);
    expect(disposicion.nodos).toHaveLength(1);
  });

  it('el lienzo es lo bastante grande para todos los nodos', () => {
    const disposicion = disponerGrafo([
      tarea('T-01'),
      tarea('T-02'),
      tarea('T-03', ['T-01', 'T-02']),
    ]);
    for (const nodo of disposicion.nodos) {
      expect(nodo.x + ANCHO_NODO).toBeLessThanOrEqual(disposicion.ancho);
      expect(nodo.y + ALTO_NODO).toBeLessThanOrEqual(disposicion.alto);
    }
  });

  it('es determinista: el mismo grafo se dibuja igual dos veces', () => {
    // Si no lo fuera, recargar la página reordenaría el grafo y el usuario perdería su
    // mapa mental de dónde estaba cada tarea.
    const tareas = [tarea('T-03', ['T-01']), tarea('T-01'), tarea('T-02', ['T-01'])];
    expect(disponerGrafo(tareas)).toEqual(disponerGrafo([...tareas].reverse()));
  });
});

describe('contarPorEstado', () => {
  it('agrupa las tareas por estado', () => {
    const cuenta = contarPorEstado([
      tarea('T-01', [], 'approved'),
      tarea('T-02', [], 'approved'),
      tarea('T-03', [], 'blocked'),
    ]);
    expect(cuenta.get('approved')).toBe(2);
    expect(cuenta.get('blocked')).toBe(1);
  });
});
