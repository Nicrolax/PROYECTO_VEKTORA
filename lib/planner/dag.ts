/**
 * VEKTORA · FASE 3 — Álgebra de grafos del planificador.
 *
 * Todo lo de este archivo es PURO: sin red, sin base de datos, sin LLM. Es lo que permite
 * probar exhaustivamente la parte del planificador donde realmente se puede equivocar.
 *
 * Convención de dirección, la misma que `task_dependencies` en db/schema.sql:
 *   arista `task -> dependsOn`  =  "task NO puede empezar hasta que dependsOn se satisfaga".
 * Por tanto las raíces del grafo (las que arrancan primero) son las que NO dependen de nadie.
 */

export interface DagNode {
  code: string;
  dependsOn: readonly string[];
  /** Peso para la ruta crítica. Horas estimadas por defecto. */
  weight?: number;
}

export interface DagEdge {
  from: string;
  to: string;
}

// -------------------------------------------------------------------------------------
// Referencias
// -------------------------------------------------------------------------------------

export interface ReferenceProblem {
  code: string;
  /** Índice de la dependencia dentro de `dependsOn`. */
  index: number;
  reference: string;
  kind: 'unknown' | 'self' | 'duplicate';
}

/** Códigos repetidos en la lista de nodos. */
export function findDuplicateCodes(nodes: readonly DagNode[]): string[] {
  const seen = new Set<string>();
  const duplicated = new Set<string>();
  for (const node of nodes) {
    if (seen.has(node.code)) duplicated.add(node.code);
    seen.add(node.code);
  }
  return [...duplicated].sort();
}

/** Dependencias que apuntan a códigos inexistentes, a sí mismas o repetidas. */
export function findReferenceProblems(nodes: readonly DagNode[]): ReferenceProblem[] {
  const known = new Set(nodes.map((node) => node.code));
  const problems: ReferenceProblem[] = [];

  for (const node of nodes) {
    const seen = new Set<string>();
    node.dependsOn.forEach((reference, index) => {
      if (reference === node.code) {
        problems.push({ code: node.code, index, reference, kind: 'self' });
        return;
      }
      if (!known.has(reference)) {
        problems.push({ code: node.code, index, reference, kind: 'unknown' });
        return;
      }
      if (seen.has(reference)) {
        problems.push({ code: node.code, index, reference, kind: 'duplicate' });
        return;
      }
      seen.add(reference);
    });
  }
  return problems;
}

// -------------------------------------------------------------------------------------
// Ciclos
// -------------------------------------------------------------------------------------

/**
 * Todos los ciclos elementales alcanzables, por DFS con pila de recursión.
 * Cada ciclo se devuelve normalizado (rotado para empezar por su código menor) y
 * deduplicado, de modo que el mensaje de error sea estable entre ejecuciones — importante
 * porque ese mensaje alimenta el prompt de auto-reparación.
 */
export function findCycles(nodes: readonly DagNode[]): string[][] {
  const adjacency = new Map<string, readonly string[]>();
  for (const node of nodes) adjacency.set(node.code, node.dependsOn);

  const visited = new Set<string>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const found = new Map<string, string[]>();

  const visit = (code: string): void => {
    visited.add(code);
    stack.push(code);
    onStack.add(code);

    for (const next of adjacency.get(code) ?? []) {
      if (!adjacency.has(next)) continue; // referencia inexistente: otro chequeo la reporta
      if (onStack.has(next)) {
        const start = stack.indexOf(next);
        if (start >= 0) {
          const cycle = normalizeCycle(stack.slice(start));
          found.set(cycle.join('>'), cycle);
        }
        continue;
      }
      if (!visited.has(next)) visit(next);
    }

    stack.pop();
    onStack.delete(code);
  };

  for (const node of nodes) {
    if (!visited.has(node.code)) visit(node.code);
  }

  return [...found.values()].sort((a, b) => a.join('>').localeCompare(b.join('>')));
}

/** Rota el ciclo para que empiece por su código menor: hace la salida determinista. */
function normalizeCycle(cycle: readonly string[]): string[] {
  if (cycle.length === 0) return [];
  let pivot = 0;
  for (let i = 1; i < cycle.length; i += 1) {
    const candidate = cycle[i];
    const current = cycle[pivot];
    if (candidate !== undefined && current !== undefined && candidate < current) pivot = i;
  }
  return [...cycle.slice(pivot), ...cycle.slice(0, pivot)];
}

export function isAcyclic(nodes: readonly DagNode[]): boolean {
  return findCycles(nodes).length === 0;
}

/** Describe un ciclo en la dirección de la dependencia, para prompts y errores. */
export function formatCycle(cycle: readonly string[]): string {
  if (cycle.length === 0) return '';
  return [...cycle, cycle[0]].join(' → ');
}

// -------------------------------------------------------------------------------------
// Orden topológico
// -------------------------------------------------------------------------------------

export interface TopologicalResult {
  /** Códigos en orden de ejecución: las raíces primero. */
  order: string[];
  /** Nodos que quedaron fuera por pertenecer a un ciclo. */
  unresolved: string[];
}

/**
 * Kahn con desempate alfabético: dos planes con el mismo grafo producen el mismo
 * `order_index`, lo que hace que un replan no reordene tareas sin motivo.
 */
export function topologicalSort(nodes: readonly DagNode[]): TopologicalResult {
  const known = new Set(nodes.map((node) => node.code));
  const pending = new Map<string, Set<string>>();
  const dependents = new Map<string, string[]>();

  for (const node of nodes) {
    const deps = new Set(node.dependsOn.filter((ref) => known.has(ref) && ref !== node.code));
    pending.set(node.code, deps);
    for (const dep of deps) {
      const list = dependents.get(dep) ?? [];
      list.push(node.code);
      dependents.set(dep, list);
    }
  }

  const ready = [...pending.entries()]
    .filter(([, deps]) => deps.size === 0)
    .map(([code]) => code)
    .sort();

  const order: string[] = [];
  while (ready.length > 0) {
    const code = ready.shift();
    if (code === undefined) break;
    order.push(code);
    pending.delete(code);

    let unlocked = false;
    for (const dependent of dependents.get(code) ?? []) {
      const deps = pending.get(dependent);
      if (deps === undefined) continue;
      deps.delete(code);
      if (deps.size === 0) {
        ready.push(dependent);
        unlocked = true;
      }
    }
    if (unlocked) ready.sort();
  }

  return { order, unresolved: [...pending.keys()].sort() };
}

// -------------------------------------------------------------------------------------
// Profundidad y ruta crítica
// -------------------------------------------------------------------------------------

/** Profundidad = longitud del camino más largo desde una raíz. Alimenta `project_tasks.depth`. */
export function computeDepths(nodes: readonly DagNode[]): Map<string, number> {
  const { order } = topologicalSort(nodes);
  const byCode = new Map(nodes.map((node) => [node.code, node]));
  const depths = new Map<string, number>();

  for (const code of order) {
    const node = byCode.get(code);
    if (node === undefined) continue;
    let depth = 0;
    for (const dep of node.dependsOn) {
      const parentDepth = depths.get(dep);
      if (parentDepth !== undefined) depth = Math.max(depth, parentDepth + 1);
    }
    depths.set(code, depth);
  }

  // Los nodos en ciclo no tienen profundidad definida: se marcan en 0 para no romper inserts.
  for (const node of nodes) if (!depths.has(node.code)) depths.set(node.code, 0);
  return depths;
}

export interface CriticalPath {
  path: string[];
  totalWeight: number;
}

/**
 * Camino de mayor peso acumulado. Con `weight` = horas estimadas da la duración mínima
 * del proyecto aunque todo lo paralelizable se ejecute en paralelo.
 */
export function criticalPath(nodes: readonly DagNode[]): CriticalPath {
  const { order } = topologicalSort(nodes);
  const byCode = new Map(nodes.map((node) => [node.code, node]));
  const best = new Map<string, { weight: number; previous: string | null }>();

  for (const code of order) {
    const node = byCode.get(code);
    if (node === undefined) continue;
    const own = node.weight ?? 1;
    let bestWeight = own;
    let previous: string | null = null;

    for (const dep of node.dependsOn) {
      const upstream = best.get(dep);
      if (upstream === undefined) continue;
      const candidate = upstream.weight + own;
      if (candidate > bestWeight) {
        bestWeight = candidate;
        previous = dep;
      }
    }
    best.set(code, { weight: bestWeight, previous });
  }

  let tail: string | null = null;
  let total = 0;
  for (const [code, entry] of best) {
    if (entry.weight > total) {
      total = entry.weight;
      tail = code;
    }
  }

  const path: string[] = [];
  let cursor = tail;
  while (cursor !== null) {
    path.unshift(cursor);
    cursor = best.get(cursor)?.previous ?? null;
  }

  return { path, totalWeight: Math.round(total * 100) / 100 };
}

/** Niveles de paralelismo: cada nivel puede ejecutarse simultáneamente. */
export function executionLevels(nodes: readonly DagNode[]): string[][] {
  const depths = computeDepths(nodes);
  const levels = new Map<number, string[]>();
  for (const node of nodes) {
    const depth = depths.get(node.code) ?? 0;
    const bucket = levels.get(depth) ?? [];
    bucket.push(node.code);
    levels.set(depth, bucket);
  }
  return [...levels.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, codes]) => codes.sort());
}

/** Códigos sin dependencias: arrancan en `ready`, el resto en `blocked`. */
export function rootCodes(nodes: readonly DagNode[]): string[] {
  const known = new Set(nodes.map((node) => node.code));
  return nodes
    .filter((node) => node.dependsOn.filter((ref) => known.has(ref)).length === 0)
    .map((node) => node.code)
    .sort();
}

/** Nodos de los que nadie depende: entregables finales del proyecto. */
export function leafCodes(nodes: readonly DagNode[]): string[] {
  const referenced = new Set<string>();
  for (const node of nodes) for (const dep of node.dependsOn) referenced.add(dep);
  return nodes
    .map((node) => node.code)
    .filter((code) => !referenced.has(code))
    .sort();
}

// -------------------------------------------------------------------------------------
// Ruptura determinista de ciclos (último recurso)
// -------------------------------------------------------------------------------------

export interface BrokenEdge {
  from: string;
  to: string;
  cycle: string[];
}

export interface CycleBreakResult {
  nodes: DagNode[];
  removed: BrokenEdge[];
}

/**
 * Rompe los ciclos que el modelo no supo corregir ni tras la auto-reparación.
 *
 * Se elimina la arista de "retroceso" de cada ciclo: la que va del código MAYOR al MENOR
 * en el orden del ciclo normalizado. Es una elección arbitraria pero determinista y
 * explicable — que es lo que hace falta para que quede auditada en `planner_metadata` y
 * para que dos ejecuciones sobre el mismo plan produzcan el mismo grafo.
 *
 * La alternativa sería abortar, pero eso exigiría intervención humana y la regla 1 del
 * proyecto lo prohíbe.
 */
export function breakCycles(nodes: readonly DagNode[]): CycleBreakResult {
  const working = nodes.map((node) => ({ ...node, dependsOn: [...node.dependsOn] }));
  const byCode = new Map(working.map((node) => [node.code, node]));
  const removed: BrokenEdge[] = [];
  const maxIterations = working.length * working.length + 1;

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    const cycles = findCycles(working);
    const cycle = cycles[0];
    if (cycle === undefined) break;

    // Arista a cortar: desde el nodo de código mayor hacia su siguiente en el ciclo.
    let pivot = 0;
    for (let i = 1; i < cycle.length; i += 1) {
      const candidate = cycle[i];
      const current = cycle[pivot];
      if (candidate !== undefined && current !== undefined && candidate > current) pivot = i;
    }
    const from = cycle[pivot];
    const to = cycle[(pivot + 1) % cycle.length];
    if (from === undefined || to === undefined) break;

    const node = byCode.get(from);
    if (node === undefined) break;
    node.dependsOn = node.dependsOn.filter((reference) => reference !== to);
    removed.push({ from, to, cycle: [...cycle] });
  }

  return { nodes: working, removed };
}

/** Quita auto-referencias, duplicados y referencias inexistentes. */
export function pruneInvalidReferences(nodes: readonly DagNode[]): CycleBreakResult {
  const known = new Set(nodes.map((node) => node.code));
  const removed: BrokenEdge[] = [];

  const cleaned = nodes.map((node) => {
    const seen = new Set<string>();
    const dependsOn: string[] = [];
    for (const reference of node.dependsOn) {
      const invalid = reference === node.code || !known.has(reference) || seen.has(reference);
      if (invalid) {
        removed.push({ from: node.code, to: reference, cycle: [] });
        continue;
      }
      seen.add(reference);
      dependsOn.push(reference);
    }
    return { ...node, dependsOn };
  });

  return { nodes: cleaned, removed };
}

export interface DagStats {
  taskCount: number;
  edgeCount: number;
  depth: number;
  roots: string[];
  leaves: string[];
  levels: string[][];
  criticalPath: CriticalPath;
}

export function describeDag(nodes: readonly DagNode[]): DagStats {
  const levels = executionLevels(nodes);
  return {
    taskCount: nodes.length,
    edgeCount: nodes.reduce((total, node) => total + node.dependsOn.length, 0),
    depth: levels.length,
    roots: rootCodes(nodes),
    leaves: leafCodes(nodes),
    levels,
    criticalPath: criticalPath(nodes),
  };
}

/** Aristas planas listas para insertar en `task_dependencies`. */
export function toEdges(nodes: readonly DagNode[]): DagEdge[] {
  const edges: DagEdge[] = [];
  for (const node of nodes) {
    for (const dependency of node.dependsOn) edges.push({ from: node.code, to: dependency });
  }
  return edges;
}
