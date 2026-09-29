/**
 * VEKTORA — Calibración de los umbrales del espacio vectorial.
 *
 *   npm run skills:calibrate
 *
 * Mide la distribución real de similitudes y propone valores para
 * `VEKTORA_SKILL_MATCH_THRESHOLD` (FASE 3.5) y para la recalibración del componente
 * vectorial del matching (`VEKTORA_MATCH_VECTOR_FLOOR` / `_CEILING`, FASE 4).
 *
 * Existe porque esos tres números se eligieron por intuición, y la intuición falla aquí:
 * `gemini-embedding-001` comprime el rango dinámico, así que un umbral que "suena bajo"
 * puede estar fusionando tres cuartas partes del catálogo sin que nada falle.
 *
 * No gasta cuota: los embeddings ya están en la base y el cálculo es SQL.
 */

import '@/lib/env';

import { errorMessage } from '@/lib/ai/errors';
import { getMatchingConfig } from '@/lib/matching';
import { getSupabaseAdmin, isSupabaseAdminConfigured } from '@/lib/supabase/admin';

interface PairRow {
  slug_a: string;
  slug_b: string;
  similarity: number | string;
}

interface Pair {
  a: string;
  b: string;
  similarity: number;
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.round((p / 100) * (sorted.length - 1))),
  );
  return sorted[index] ?? Number.NaN;
}

function histogram(values: readonly number[], from = 0.5, to = 1, buckets = 10): string[] {
  const width = (to - from) / buckets;
  const counts = new Array<number>(buckets).fill(0);
  for (const value of values) {
    if (value < from) continue;
    const index = Math.min(buckets - 1, Math.floor((value - from) / width));
    counts[index] = (counts[index] ?? 0) + 1;
  }
  const max = Math.max(1, ...counts);
  return counts.map((count, index) => {
    const lo = (from + index * width).toFixed(2);
    const hi = (from + (index + 1) * width).toFixed(2);
    return `  ${lo}–${hi}  ${String(count).padStart(5)}  ${'█'.repeat(Math.round((count / max) * 40))}`;
  });
}

/** Ventana [suelo, techo] medida sobre la distribución que usa el matching. */
interface MeasuredWindow {
  floor: number;
  ceiling: number;
}

/**
 * Distribución TAREA vs PERFIL, que es la que de verdad usa el matching.
 *
 * La muestra skill-vs-skill son textos cortos; esta son textos largos y su geometría es
 * distinta. Hasta que haya datos, se dice que no los hay en vez de extrapolar.
 *
 * Devuelve la ventana medida, o `null` si no pudo medirse. El llamador la necesita para
 * NO imprimir a la vez una sugerencia extrapolada que la contradiga: dos sugerencias
 * distintas en la misma pantalla es cómo se acaba pegando la equivocada en `.env.local`.
 */
async function reportTaskProviderDistances(): Promise<MeasuredWindow | null> {
  const client = getSupabaseAdmin();

  console.log('\nDistribución TAREA vs PERFIL (la que usa el matching)');
  console.log('─────────────────────────────────────────────────────');

  const [tasks, providers] = await Promise.all([
    client
      .from('project_tasks')
      .select('id, code, title', { count: 'exact' })
      .not('embedding', 'is', null)
      .limit(1),
    client
      .from('provider_profiles')
      .select('id', { count: 'exact', head: true })
      .not('embedding', 'is', null),
  ]);

  const taskCount = tasks.count ?? 0;
  const providerCount = providers.count ?? 0;

  if (taskCount === 0 || providerCount < 2) {
    console.log(
      `  Sin datos suficientes: ${taskCount} tarea(s) y ${providerCount} perfil(es) vectorizados.\n` +
        '  Hacen falta al menos 1 tarea y 2 proveedores para que la comparación signifique algo.\n\n' +
        '  Cuando los haya, este bloque medirá la distribución real y VEKTORA_MATCH_VECTOR_FLOOR\n' +
        '  / _CEILING dejarán de ser una extrapolación de la muestra skill-vs-skill.\n',
    );
    return null;
  }

  const task = (tasks.data ?? [])[0] as { id: string; code: string; title: string } | undefined;
  if (task === undefined) return null;

  const { data, error } = await client.rpc('match_task_candidates', {
    p_task_id: task.id,
    p_limit: 50,
    p_require_auto_assign: false,
  });
  if (error !== null) {
    console.log(`  No se pudo medir -> ${error.message}\n`);
    return null;
  }

  const similarities = ((data ?? []) as Array<{ vector_similarity: number | string | null }>)
    .map((row) => (row.vector_similarity === null ? null : Number(row.vector_similarity)))
    .filter((value): value is number => value !== null && Number.isFinite(value))
    .sort((a, b) => a - b);

  if (similarities.length === 0) {
    console.log('  Ningún candidato con embedding para esa tarea.\n');
    return null;
  }

  const lo = similarities[0] ?? 0;
  const hi = similarities[similarities.length - 1] ?? 0;
  console.log(`  Tarea de referencia: ${task.code} · ${task.title}`);
  console.log(`  Perfiles comparados: ${similarities.length}`);
  console.log(
    `  mín ${lo.toFixed(4)}   mediana ${percentile(similarities, 50).toFixed(4)}   máx ${hi.toFixed(4)}`,
  );
  const measured: MeasuredWindow = {
    floor: Math.floor(lo * 100) / 100,
    ceiling: Math.min(1, Math.ceil(hi * 100) / 100 + 0.02),
  };
  console.log(
    '\n  Con pocos perfiles esto es orientativo: los extremos de una muestra pequeña se\n' +
      '  mueven mucho. Vuelve a correrlo cuando haya más proveedores.\n',
  );
  return measured;
}

async function main(): Promise<void> {
  if (!isSupabaseAdminConfigured()) {
    console.error('\nFaltan SUPABASE_URL y/o SUPABASE_SERVICE_ROLE_KEY en .env.local.\n');
    process.exitCode = 1;
    return;
  }

  console.log('\n══════════════════════════════════════════════════════');
  console.log(' VEKTORA · calibración del espacio vectorial');
  console.log('══════════════════════════════════════════════════════\n');

  const client = getSupabaseAdmin();
  const { data, error } = await client.rpc('skill_similarity_pairs', {
    p_min: 0,
    p_limit: 10_000,
  });

  if (error !== null) {
    console.error(
      `No se pudo calcular la matriz -> ${error.message}\n` +
        '(¿falta db/migrations/0004_matching.sql?)\n',
    );
    process.exitCode = 1;
    return;
  }

  const pairs: Pair[] = ((data ?? []) as PairRow[]).map((row) => ({
    a: row.slug_a,
    b: row.slug_b,
    similarity: Number(row.similarity),
  }));

  if (pairs.length === 0) {
    console.error('No hay pares comparables. ¿Ejecutaste `npm run skills:embed`?\n');
    process.exitCode = 1;
    return;
  }

  const values = pairs.map((pair) => pair.similarity).sort((a, b) => a - b);
  const n = values.length;
  const minValue = values[0] ?? 0;
  const maxDistinct = values[n - 1] ?? 0;

  console.log(`Pares comparados: ${n}\n`);
  console.log('Distribución de similitud entre skills DISTINTAS');
  console.log('────────────────────────────────────────────────');
  for (const row of histogram(values)) console.log(row);

  const p = (value: number): string => percentile(values, value).toFixed(4);
  console.log('\nPercentiles');
  console.log('───────────');
  console.log(`  mín ${minValue.toFixed(4)}   p25 ${p(25)}   mediana ${p(50)}`);
  console.log(`  p75 ${p(75)}   p90 ${p(90)}   p95 ${p(95)}   p99 ${p(99)}`);
  console.log(`  máx ${maxDistinct.toFixed(4)}\n`);

  const sortedDesc = [...pairs].sort((a, b) => b.similarity - a.similarity);
  console.log('Los 15 pares MÁS parecidos (y aun así, skills distintas)');
  console.log('────────────────────────────────────────────────────────');
  for (const pair of sortedDesc.slice(0, 15)) {
    console.log(`  ${pair.similarity.toFixed(4)}  ${pair.a}  ~  ${pair.b}`);
  }

  // --- Lectura -----------------------------------------------------------------------
  const config = getMatchingConfig();
  const threshold = Number(process.env['VEKTORA_SKILL_MATCH_THRESHOLD'] ?? 0.95);
  const fused = pairs.filter((pair) => pair.similarity >= threshold);

  console.log('\nQué significa esto');
  console.log('──────────────────');
  console.log(
    `  Los ${n} pares de arriba son de skills que el catálogo considera DISTINTAS. Un umbral\n` +
      '  por debajo de cualquiera de esos valores las fusionaría si alguien las escribiera de\n' +
      '  otra forma.',
  );
  console.log(
    `\n  Con VEKTORA_SKILL_MATCH_THRESHOLD=${threshold} se fusionarían ${fused.length} de ${n} ` +
      `pares (${((fused.length / n) * 100).toFixed(1)}%).`,
  );

  if (fused.length > 0) {
    console.log('\n  Se fusionarían estos pares, que NO son sinónimos:');
    for (const pair of fused.sort((a, b) => b.similarity - a.similarity).slice(0, 10)) {
      console.log(`    ${pair.similarity.toFixed(4)}  ${pair.a}  ->  ${pair.b}`);
    }
  }

  // El criterio NO es un percentil. Los N pares son TODOS distintos por construcción, así
  // que el umbral tiene que superar el MÁXIMO del conjunto, no su p99: un percentil deja
  // fuera justo el extremo que hay que proteger (`ui-design` ~ `graphic-design`).
  const suggested = Math.min(0.99, Math.ceil((maxDistinct + 0.02) * 100) / 100);
  const worst = sortedDesc[0];

  console.log('\n  Criterio: el umbral debe superar el par MÁS parecido de los que sabemos');
  console.log('  distintos, con margen. No un percentil: los percentiles descartan justo el');
  console.log('  extremo que hay que proteger.');
  if (worst !== undefined) {
    console.log(
      `\n  Par distinto más parecido: ${worst.similarity.toFixed(4)}  (${worst.a} ~ ${worst.b})`,
    );
  }
  console.log(`  SUGERENCIA: VEKTORA_SKILL_MATCH_THRESHOLD=${suggested.toFixed(2)}`);
  console.log(
    '\n  Cordura: los sinónimos reales medidos en altas de proveedor (next-js~nextjs 0.990,\n' +
      '  postgres~postgresql 0.989) siguen por encima de ese valor, así que se seguirían\n' +
      '  fusionando como corresponde.',
  );

  // --- Recalibración del componente vectorial -----------------------------------------
  console.log('\n');
  const measured = await reportTaskProviderDistances();

  const floor = Math.floor(minValue * 100) / 100;
  console.log('Recalibración del componente vectorial (FASE 4)');
  console.log('───────────────────────────────────────────────');
  console.log(`  Configurado hoy: [${config.vector.floor}, ${config.vector.ceiling}]`);

  if (measured !== null) {
    // Hay medición real: la muestra skill-vs-skill queda como contexto, no como consejo.
    console.log(
      `  Entre skills distintas nada baja de ${minValue.toFixed(4)}, pero esa muestra son\n` +
        '  textos de dos palabras. El matching compara TAREA vs PERFIL, y esa distribución\n' +
        '  —la del bloque de arriba— es la que manda. Se ignora la extrapolación.',
    );
    console.log(
      `\n  SUGERENCIA (medida): VEKTORA_MATCH_VECTOR_FLOOR=${measured.floor.toFixed(2)} ` +
        `· VEKTORA_MATCH_VECTOR_CEILING=${measured.ceiling.toFixed(2)}`,
    );
    if (
      Math.abs(measured.floor - config.vector.floor) < 1e-9 &&
      Math.abs(measured.ceiling - config.vector.ceiling) < 1e-9
    ) {
      console.log('  Es exactamente lo que ya tienes configurado: no hay nada que cambiar.');
    } else {
      console.log('  Ponlas en .env.local y vuelve a correr `npm run match -- <task_id> --dry-run`.');
    }
  } else {
    console.log(
      `  En este espacio ninguna similitud baja de ${minValue.toFixed(4)}, así que todo el tramo\n` +
        `  por debajo de ${floor.toFixed(2)} es rango muerto: no discrimina nada.`,
    );
    console.log(
      `  SUGERENCIA (EXTRAPOLADA de skill-vs-skill, provisional): suelo ${floor.toFixed(2)}, techo 0.98`,
    );
  }

  console.log('\n══════════════════════════════════════════════════════\n');
}

main().catch((error: unknown) => {
  console.error(`\nVEKTORA: la calibración falló -> ${errorMessage(error)}\n`);
  process.exitCode = 1;
});
