/**
 * VEKTORA · FASE 3 — Reparto de presupuesto.
 *
 * El modelo devuelve fracciones (`budgetShare`) que suman ~1. Convertirlas a dinero con
 * `Math.round` tarea a tarea deja céntimos perdidos: 3 tareas al 33,33% de 100 suman 99,99.
 * Eso importa porque `projects.budget_total` es el compromiso con el cliente y la suma de
 * `project_tasks.budget` es lo que se paga.
 *
 * Se usa el método del resto mayor (Hamilton): reparto exacto al céntimo, determinista y
 * con el sobrante asignado a las tareas de mayor resto.
 */

export interface BudgetSlice {
  code: string;
  share: number;
}

export interface BudgetAllocation {
  code: string;
  /** `null` si el proyecto no declara presupuesto. */
  budget: number | null;
}

/** Normaliza fracciones para que sumen exactamente 1. */
export function normalizeShares(slices: readonly BudgetSlice[]): BudgetSlice[] {
  const total = slices.reduce((sum, slice) => sum + slice.share, 0);
  if (total <= 0) {
    // Sin señal útil del modelo: reparto uniforme.
    const even = slices.length === 0 ? 0 : 1 / slices.length;
    return slices.map((slice) => ({ code: slice.code, share: even }));
  }
  return slices.map((slice) => ({ code: slice.code, share: slice.share / total }));
}

/**
 * Reparte `budgetTotal` entre las tareas. La suma de los importes devueltos es exactamente
 * `budgetTotal` redondeado a 2 decimales.
 */
export function allocateBudget(
  slices: readonly BudgetSlice[],
  budgetTotal: number | null | undefined,
): BudgetAllocation[] {
  if (budgetTotal === null || budgetTotal === undefined || budgetTotal <= 0) {
    return slices.map((slice) => ({ code: slice.code, budget: null }));
  }
  if (slices.length === 0) return [];

  const normalized = normalizeShares(slices);

  // Se trabaja en céntimos para evitar el error de coma flotante del redondeo.
  const totalCents = Math.round(budgetTotal * 100);
  const exact = normalized.map((slice) => ({
    code: slice.code,
    cents: slice.share * totalCents,
  }));

  const floors = exact.map((entry) => ({
    code: entry.code,
    cents: Math.floor(entry.cents),
    remainder: entry.cents - Math.floor(entry.cents),
  }));

  let assigned = floors.reduce((sum, entry) => sum + entry.cents, 0);
  let leftover = totalCents - assigned;

  // Resto mayor primero; empate por código para que el resultado sea reproducible.
  const byRemainder = [...floors].sort(
    (a, b) => b.remainder - a.remainder || a.code.localeCompare(b.code),
  );

  let cursor = 0;
  while (leftover > 0 && byRemainder.length > 0) {
    const entry = byRemainder[cursor % byRemainder.length];
    if (entry === undefined) break;
    entry.cents += 1;
    leftover -= 1;
    cursor += 1;
  }

  // Si el modelo pasó fracciones que suman >1 el redondeo puede sobrepasar: se descuenta
  // de los restos menores.
  const byRemainderAsc = [...floors].sort(
    (a, b) => a.remainder - b.remainder || a.code.localeCompare(b.code),
  );
  cursor = 0;
  while (leftover < 0 && byRemainderAsc.length > 0) {
    const entry = byRemainderAsc[cursor % byRemainderAsc.length];
    if (entry === undefined) break;
    if (entry.cents > 0) {
      entry.cents -= 1;
      leftover += 1;
    }
    cursor += 1;
    if (cursor > byRemainderAsc.length * 200) break;
  }

  assigned = floors.reduce((sum, entry) => sum + entry.cents, 0);
  const byCode = new Map(floors.map((entry) => [entry.code, entry.cents]));

  return slices.map((slice) => ({
    code: slice.code,
    budget: (byCode.get(slice.code) ?? 0) / 100,
  }));
}
