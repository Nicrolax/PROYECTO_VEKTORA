/**
 * Reparto de presupuesto. El invariante que se prueba es uno solo pero es el que importa:
 * la suma de `project_tasks.budget` debe coincidir EXACTAMENTE con `projects.budget_total`.
 * Ahí es donde el redondeo ingenuo pierde céntimos y donde el cliente lo nota.
 */

import { describe, expect, it } from 'vitest';
import { allocateBudget, normalizeShares, type BudgetSlice } from '@/lib/planner/budget';

const sum = (values: Array<number | null>): number =>
  values.reduce<number>((total, value) => total + (value ?? 0), 0);

const slices = (...shares: number[]): BudgetSlice[] =>
  shares.map((share, index) => ({ code: `T-0${index + 1}`, share }));

describe('normalizeShares', () => {
  it('normaliza a suma 1', () => {
    const normalized = normalizeShares(slices(2, 3, 5));
    expect(sum(normalized.map((slice) => slice.share))).toBeCloseTo(1, 12);
  });

  it('reparte de forma uniforme cuando no hay señal útil', () => {
    const normalized = normalizeShares(slices(0, 0, 0));
    for (const slice of normalized) expect(slice.share).toBeCloseTo(1 / 3, 12);
  });

  it('tolera una lista vacía', () => {
    expect(normalizeShares([])).toEqual([]);
  });
});

describe('allocateBudget', () => {
  it('el caso que rompe el redondeo ingenuo: 3 tareas al 33,33% de 100', () => {
    const allocations = allocateBudget(slices(1 / 3, 1 / 3, 1 / 3), 100);
    expect(sum(allocations.map((entry) => entry.budget))).toBe(100);
  });

  it('suma exacta con el presupuesto del ejemplo de la FASE 3', () => {
    const allocations = allocateBudget(slices(0.4, 0.3, 0.2, 0.1), 3000);
    expect(sum(allocations.map((entry) => entry.budget))).toBe(3000);
  });

  it('mantiene la exactitud con repartos irregulares', () => {
    for (const total of [1, 7.77, 99.99, 1234.56, 100000]) {
      const allocations = allocateBudget(slices(0.17, 0.23, 0.31, 0.29), total);
      const assigned = sum(allocations.map((entry) => entry.budget));
      expect(assigned).toBeCloseTo(Math.round(total * 100) / 100, 10);
    }
  });

  it('corrige fracciones que no suman 1', () => {
    const allocations = allocateBudget(slices(0.5, 0.5, 0.5), 300);
    expect(sum(allocations.map((entry) => entry.budget))).toBe(300);
  });

  it('sin presupuesto declarado devuelve null, no cero', () => {
    for (const total of [null, undefined, 0]) {
      const allocations = allocateBudget(slices(0.5, 0.5), total);
      expect(allocations.every((entry) => entry.budget === null)).toBe(true);
    }
  });

  it('el sobrante va a los restos mayores y el resultado es determinista', () => {
    const first = allocateBudget(slices(0.333, 0.333, 0.334), 10);
    const second = allocateBudget(slices(0.333, 0.333, 0.334), 10);
    expect(first).toEqual(second);
    expect(sum(first.map((entry) => entry.budget))).toBe(10);
  });

  it('conserva el orden de entrada', () => {
    const allocations = allocateBudget(slices(0.2, 0.3, 0.5), 100);
    expect(allocations.map((entry) => entry.code)).toEqual(['T-01', 'T-02', 'T-03']);
  });

  it('una lista vacía no produce reparto', () => {
    expect(allocateBudget([], 100)).toEqual([]);
  });
});
