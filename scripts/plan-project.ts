/**
 * VEKTORA · FASE 3 — Planificación de un proyecto real, de punta a punta.
 *
 *   npm run plan -- "Necesito un micrositio de captación con formulario y analítica" [presupuesto]
 *
 * Requisitos: GROQ_API_KEY o GOOGLE_AI_API_KEY, y SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
 * con `db/schema.sql` y `db/migrations/0002_planner.sql` ya aplicados.
 *
 * Propietario del proyecto: se usa VEKTORA_OWNER_ID si está definido, y se VERIFICA que
 * exista en `public.users` antes de gastar una llamada al modelo — un uuid que no está en
 * la tabla falla como violación de clave foránea a mitad del insert, después de haber
 * pagado la generación del plan. Si no está definido, se toma el usuario más antiguo.
 *
 * No imprime ninguna clave.
 */

import '@/lib/env';

import { errorMessage } from '@/lib/ai/errors';
import { createProjectPlanner } from '@/lib/planner';
import { SupabasePlannerRepository } from '@/lib/planner/repository';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { toNumber } from '@/lib/supabase/types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function line(label: string, value: string): void {
  console.log(`  ${label.padEnd(22)} ${value}`);
}

interface OwnerResolution {
  id: string;
  email: string | null;
  source: 'VEKTORA_OWNER_ID' | 'public.users';
}

/**
 * Resuelve y VERIFICA el propietario contra `public.users`.
 *
 * `public.users` es la proyección de `auth.users` que crea el bootstrap de la FASE 1:
 * `projects.owner_id` referencia esa tabla, no `auth.users` directamente.
 */
async function resolveOwner(): Promise<OwnerResolution> {
  const client = getSupabaseAdmin();
  const fromEnv = process.env['VEKTORA_OWNER_ID']?.trim();

  if (fromEnv !== undefined && fromEnv !== '') {
    if (!UUID_RE.test(fromEnv)) {
      throw new Error(
        `VEKTORA_OWNER_ID="${fromEnv}" no es un UUID válido. Debe ser el id de una fila de ` +
          'public.users (el mismo uuid que en auth.users).',
      );
    }

    const { data, error } = await client
      .from('users')
      .select('id, email, status')
      .eq('id', fromEnv)
      .maybeSingle();

    if (error !== null) {
      throw new Error(
        `no se pudo consultar public.users -> ${error.message}. ¿Aplicaste db/schema.sql?`,
      );
    }
    if (data === null) {
      throw new Error(
        `VEKTORA_OWNER_ID=${fromEnv} no existe en public.users. Crea la cuenta en Supabase ` +
          'Auth (el trigger de la FASE 1 la proyecta a public.users) o quita la variable ' +
          'para usar el primer usuario disponible.',
      );
    }

    const row = data as { id: string; email: string | null; status?: string };
    if (row.status === 'suspended' || row.status === 'deleted') {
      throw new Error(
        `el usuario ${fromEnv} está en estado "${row.status}": no puede ser propietario de ` +
          'un proyecto nuevo.',
      );
    }
    return { id: row.id, email: row.email, source: 'VEKTORA_OWNER_ID' };
  }

  const { data, error } = await client
    .from('users')
    .select('id, email')
    .eq('status', 'active')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error !== null) {
    throw new Error(
      `no se pudo leer public.users -> ${error.message}. ¿Aplicaste db/schema.sql?`,
    );
  }
  const row = data as { id: string; email: string | null } | null;
  if (row === null) {
    throw new Error(
      'no hay ningún usuario activo en public.users. Crea una cuenta en Supabase Auth o ' +
        'define VEKTORA_OWNER_ID con el uuid de un usuario existente.',
    );
  }
  return { id: row.id, email: row.email, source: 'public.users' };
}

function usage(): void {
  console.error('\nUso: npm run plan -- "<objetivo en lenguaje natural>" [presupuesto]\n');
}

async function main(): Promise<void> {
  const objective = process.argv[2];
  if (objective === undefined || objective.trim().length < 10) {
    usage();
    process.exitCode = 1;
    return;
  }

  const budgetArg = process.argv[3];
  const budgetTotal =
    budgetArg === undefined || budgetArg.trim() === '' ? null : Number(budgetArg);
  if (budgetTotal !== null && (!Number.isFinite(budgetTotal) || budgetTotal < 0)) {
    console.error('\nEl presupuesto debe ser un número no negativo.\n');
    process.exitCode = 1;
    return;
  }

  console.log('\n=== VEKTORA · FASE 3 · ProjectPlanner ===\n');

  const owner = await resolveOwner();
  const planner = createProjectPlanner({
    repository: new SupabasePlannerRepository(getSupabaseAdmin()),
  });

  console.log('[0] Propietario');
  line('owner_id:', owner.id);
  line('email:', owner.email ?? '(sin email)');
  line('origen:', owner.source);
  console.log();

  const started = Date.now();
  const result = await planner.planProject({
    create: { ownerId: owner.id, objective, budgetTotal },
  });

  console.log('[1] Proyecto');
  line('id:', result.project.id);
  line('título:', result.project.title);
  line(
    'presupuesto:',
    budgetTotal === null ? '(sin declarar)' : `${budgetTotal} ${result.project.currency}`,
  );
  console.log();

  console.log('[2] Generación');
  line('proveedor:', `${result.ai.provider} · ${result.ai.model}`);
  line('esquema estricto:', result.ai.strictSchema ? 'sí' : 'no (fallback determinista)');
  line('intentos / repar.:', `${result.ai.attempts} / ${result.ai.repairs}`);
  line('ai_runs:', result.ai.runId ?? '(telemetría desactivada)');
  console.log();

  console.log('[3] DAG');
  line('tareas / aristas:', `${result.taskCount} / ${result.edgeCount}`);
  line('profundidad:', String(result.stats.depth));
  line('raíces:', result.stats.roots.join(', '));
  line('hojas:', result.stats.leaves.join(', '));
  line(
    'ruta crítica:',
    `${result.stats.criticalPath.path.join(' → ')} (${result.stats.criticalPath.totalWeight} h)`,
  );
  result.stats.levels.forEach((level, index) => {
    line(`nivel ${index}:`, level.join(', '));
  });
  console.log();

  console.log('[4] Tareas persistidas');
  const { data, error } = await getSupabaseAdmin()
    .from('project_tasks')
    .select('code, title, status, depth, order_index, estimated_hours, budget, required_skills')
    .eq('project_id', result.project.id)
    .order('order_index', { ascending: true });

  if (error !== null) {
    console.log(`  (no se pudieron releer las tareas: ${error.message})`);
  } else {
    let budgetSum = 0;
    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      const skills = Array.isArray(row['required_skills'])
        ? (row['required_skills'] as string[]).join(',')
        : '';
      const budget = toNumber(row['budget'] as number | string | null);
      if (budget !== null) budgetSum += budget;
      console.log(
        `  ${String(row['code']).padEnd(7)} ${String(row['status']).padEnd(8)} ` +
          `d${String(row['depth'])}  ${String(row['estimated_hours']).padStart(5)}h  ` +
          `${(budget === null ? '-' : budget.toFixed(2)).padStart(9)}  ` +
          `${skills.padEnd(28)} ${String(row['title'])}`,
      );
    }
    if (budgetTotal !== null && budgetTotal > 0) {
      const exact = Math.abs(budgetSum - budgetTotal) < 0.005;
      line(
        'suma de budgets:',
        `${budgetSum.toFixed(2)} / ${budgetTotal.toFixed(2)} ${exact ? '✓ exacto' : '✗ DESCUADRA'}`,
      );
    }
  }
  console.log();

  if (result.corrections.length > 0) {
    console.log('[5] Correcciones automáticas del grafo');
    for (const correction of result.corrections) {
      console.log(`  · [${correction.kind}] ${correction.detail}`);
    }
    console.log();
  }

  console.log('[6] Extras');
  line('skills nuevas:', result.newSkills.length > 0 ? result.newSkills.join(', ') : '(ninguna)');
  line('tareas vectorizadas:', `${result.embeddedTasks}/${result.taskCount}`);
  line('tiempo total:', `${Date.now() - started} ms`);

  console.log('\n=== Plan aplicado ===\n');
}

main().catch((error: unknown) => {
  console.error(`\nVEKTORA/PLANNER: falló -> ${errorMessage(error)}\n`);
  process.exitCode = 1;
});
