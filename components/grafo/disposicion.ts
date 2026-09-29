/**
 * VEKTORA · FASE 6 — Disposición del grafo de tareas. Módulo PURO.
 *
 * Coloca las tareas en columnas por NIVEL DE EJECUCIÓN, reutilizando `executionLevels` del
 * álgebra de grafos de la FASE 3. Esa decisión importa: la posición horizontal de una tarea
 * no es estética, **es su profundidad en el grafo**, o sea cuántas aprobaciones encadenadas
 * hacen falta antes de que pueda empezar. Leer el grafo de izquierda a derecha es leer el
 * orden en que el proyecto va a ocurrir.
 *
 * Es puro y determinista a propósito: la misma entrada produce siempre el mismo dibujo, así
 * que recargar la página no reordena el grafo y el usuario no pierde su mapa mental.
 */

import { executionLevels, type DagNode } from '@/lib/planner/dag';

export const ANCHO_NODO = 208;
export const ALTO_NODO = 66;
const SEPARACION_COLUMNA = 96;
const SEPARACION_FILA = 20;
const MARGEN = 28;

export interface TareaGrafo {
  id: string;
  code: string;
  title: string;
  status: string;
  dependsOn: readonly string[];
  assigneeId: string | null;
  budget: number | null;
}

export interface NodoDispuesto {
  id: string;
  code: string;
  title: string;
  status: string;
  nivel: number;
  x: number;
  y: number;
}

export interface AristaDispuesta {
  desde: string;
  hasta: string;
  /** Curva de Bézier lista para el atributo `d` de un `path`. */
  trazo: string;
  /** true si el origen está aprobado: la dependencia ya está satisfecha. */
  satisfecha: boolean;
}

export interface Disposicion {
  nodos: NodoDispuesto[];
  aristas: AristaDispuesta[];
  ancho: number;
  alto: number;
  niveles: number;
}

/**
 * Curva horizontal entre dos nodos.
 *
 * Los puntos de control se separan la mitad de la distancia horizontal, con un mínimo, para
 * que las aristas entre columnas contiguas no queden aplastadas contra los nodos.
 */
function curva(x1: number, y1: number, x2: number, y2: number): string {
  const tiron = Math.max(36, (x2 - x1) / 2);
  return `M ${x1} ${y1} C ${x1 + tiron} ${y1}, ${x2 - tiron} ${y2}, ${x2} ${y2}`;
}

export function disponerGrafo(tareas: readonly TareaGrafo[]): Disposicion {
  if (tareas.length === 0) {
    return { nodos: [], aristas: [], ancho: 0, alto: 0, niveles: 0 };
  }

  const nodosDag: DagNode[] = tareas.map((tarea) => ({
    code: tarea.code,
    dependsOn: tarea.dependsOn,
  }));
  const niveles = executionLevels(nodosDag);
  const porCodigo = new Map(tareas.map((tarea) => [tarea.code, tarea]));

  // El nivel más poblado marca la altura del lienzo; el resto se centra respecto a él.
  const filasMaximas = niveles.reduce((maximo, nivel) => Math.max(maximo, nivel.length), 0);
  const altoUtil = filasMaximas * ALTO_NODO + Math.max(0, filasMaximas - 1) * SEPARACION_FILA;

  const nodos: NodoDispuesto[] = [];
  niveles.forEach((codigos, indiceNivel) => {
    const alturaNivel =
      codigos.length * ALTO_NODO + Math.max(0, codigos.length - 1) * SEPARACION_FILA;
    const desplazamiento = (altoUtil - alturaNivel) / 2;

    codigos.forEach((codigo, indiceFila) => {
      const tarea = porCodigo.get(codigo);
      if (tarea === undefined) return;
      nodos.push({
        id: tarea.id,
        code: tarea.code,
        title: tarea.title,
        status: tarea.status,
        nivel: indiceNivel,
        x: MARGEN + indiceNivel * (ANCHO_NODO + SEPARACION_COLUMNA),
        y: MARGEN + desplazamiento + indiceFila * (ALTO_NODO + SEPARACION_FILA),
      });
    });
  });

  const posiciones = new Map(nodos.map((nodo) => [nodo.code, nodo]));
  const aristas: AristaDispuesta[] = [];

  for (const tarea of tareas) {
    const destino = posiciones.get(tarea.code);
    if (destino === undefined) continue;

    for (const codigoOrigen of tarea.dependsOn) {
      const origen = posiciones.get(codigoOrigen);
      // Una dependencia que apunta a una tarea inexistente no se dibuja. No debería
      // ocurrir: el planificador valida las referencias antes de persistir.
      if (origen === undefined) continue;

      aristas.push({
        desde: codigoOrigen,
        hasta: tarea.code,
        trazo: curva(
          origen.x + ANCHO_NODO,
          origen.y + ALTO_NODO / 2,
          destino.x,
          destino.y + ALTO_NODO / 2,
        ),
        satisfecha: porCodigo.get(codigoOrigen)?.status === 'approved',
      });
    }
  }

  // Orden estable de las aristas. Sin esto el SVG depende del orden en que la base devolvió
  // las filas: el dibujo sale igual, pero React reconcilia nodos distintos en cada refresco
  // y el grafo parpadea al actualizarse en vivo.
  aristas.sort((a, b) => a.desde.localeCompare(b.desde) || a.hasta.localeCompare(b.hasta));

  return {
    nodos,
    aristas,
    ancho: MARGEN * 2 + niveles.length * ANCHO_NODO + Math.max(0, niveles.length - 1) * SEPARACION_COLUMNA,
    alto: MARGEN * 2 + altoUtil,
    niveles: niveles.length,
  };
}

/** Recuento por estado, en el orden de progreso, para la leyenda y el resumen. */
export function contarPorEstado(tareas: readonly TareaGrafo[]): Map<string, number> {
  const cuenta = new Map<string, number>();
  for (const tarea of tareas) {
    cuenta.set(tarea.status, (cuenta.get(tarea.status) ?? 0) + 1);
  }
  return cuenta;
}
