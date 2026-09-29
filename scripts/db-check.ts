/**
 * VEKTORA — Comprobación del despliegue de la base de datos.
 *
 *   npm run db:check
 *
 * Verifica, SIN ESCRIBIR NADA, que el Supabase apuntado por `.env.local` tiene aplicado lo
 * que el código necesita, de la FASE 1 a la 7: las tablas, las columnas que la telemetría, el
 * planificador y el juez escriben, las RPC de cada fase, la escalada y las cuotas de la 0007,
 * el catálogo semilla de skills y un propietario utilizable.
 *
 * Existe porque el modo de fallo más caro del proyecto es descubrir que falta una columna
 * a mitad de un plan ya generado: para entonces ya se pagó la llamada al modelo.
 */

import '@/lib/env';

import { errorMessage } from '@/lib/ai/errors';
import { getSupabaseAdmin, isSupabaseAdminConfigured } from '@/lib/supabase/admin';

const TABLES = [
  'users',
  'profiles',
  'provider_profiles',
  'skills',
  'provider_skills',
  'projects',
  'project_tasks',
  'task_dependencies',
  'task_applications',
  'deliverables',
  'reviews',
  'reputation_events',
  'ai_runs',
  'audit_logs',
  'skill_aliases',
] as const;

/** Columnas que el código escribe explícitamente. Si falta una, el insert revienta. */
const REQUIRED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  ai_runs: [
    'operation',
    'provider',
    'model',
    'status',
    'attempt',
    'fell_back_from',
    'parent_run_id',
    'user_id',
    'project_id',
    'task_id',
    'request_payload',
    'response_payload',
    'zod_errors',
    'error_message',
    'prompt_tokens',
    'completion_tokens',
    'total_tokens',
    'latency_ms',
    'cost_usd',
    'started_at',
    'finished_at',
  ],
  projects: [
    'owner_id',
    'title',
    'objective',
    'status',
    'visibility',
    'currency',
    'budget_total',
    'deadline',
    'acceptance_policy',
    'planner_metadata',
  ],
  project_tasks: [
    'project_id',
    'code',
    'title',
    'description',
    'acceptance_criteria',
    'required_skills',
    'estimated_hours',
    'budget',
    'priority',
    'order_index',
    'depth',
    'status',
    'assignee_id',
    'embedding',
    'embedding_model',
    'embedding_updated_at',
    // FASE 7 (0007): el emparejador lo lee en cada ronda para decidir si escala.
    'matching_rounds',
  ],
  skills: ['slug', 'name', 'category', 'is_active', 'embedding', 'embedding_model'],
  // Lo que escribe el AI Judge de la FASE 5. Si falta una, el veredicto revienta DESPUÉS
  // de haber pagado la llamada al modelo.
  deliverables: [
    'task_id',
    'provider_id',
    'version',
    'summary',
    'content',
    'artifacts',
    'evidence',
    'qa_status',
    'qa_score',
    'qa_feedback',
    'qa_criteria_results',
    'qa_run_id',
    'qa_evaluated_at',
    'submitted_at',
  ],
  reviews: ['task_id', 'deliverable_id', 'reviewer_id', 'reviewee_id', 'source', 'rating'],
  reputation_events: ['user_id', 'event_type', 'delta', 'weight', 'task_id', 'deliverable_id'],
  skill_aliases: ['alias', 'skill_id', 'similarity', 'source'],
  users: ['id', 'email', 'role', 'status', 'is_agent'],
};

let failures = 0;
const ok = (message: string): void => console.log(`   ✓ ${message}`);
const info = (message: string): void => console.log(`   · ${message}`);
function fail(message: string): void {
  failures += 1;
  console.log(`   ✗ ${message}`);
}

function header(title: string): void {
  console.log(`\n${title}`);
  console.log('─'.repeat(title.length));
}

async function checkTables(): Promise<void> {
  header('[1] Tablas');
  const client = getSupabaseAdmin();

  for (const table of TABLES) {
    const { error } = await client.from(table).select('*', { head: true, count: 'exact' });
    if (error !== null) {
      fail(`${table}: ${error.message}`);
      continue;
    }
    const columns = REQUIRED_COLUMNS[table];
    if (columns === undefined) {
      ok(table);
      continue;
    }
    // `limit(0)` y NO `head: true`: con una petición HEAD, PostgREST no devuelve cuerpo y
    // el motivo del 400 se pierde, así que el error llegaría con el mensaje vacío. Con
    // `limit(0)` tampoco viajan filas pero el error sí trae el nombre de la columna.
    const probe = await client.from(table).select(columns.join(', ')).limit(0);
    if (probe.error !== null) {
      const detail = [probe.error.message, probe.error.hint, probe.error.details]
        .filter((part) => typeof part === 'string' && part.trim() !== '')
        .join(' · ');
      fail(`${table}: falta alguna columna -> ${detail || `código ${probe.error.code ?? '?'}`}`);
      // Se reintenta columna a columna para decir EXACTAMENTE cuál falta.
      const missing: string[] = [];
      for (const column of columns) {
        const single = await client.from(table).select(column).limit(0);
        if (single.error !== null) missing.push(column);
      }
      if (missing.length > 0) info(`columnas ausentes: ${missing.join(', ')}`);
    } else {
      ok(`${table} (${columns.length} columnas verificadas)`);
    }
  }
}

async function checkRpcAndViews(): Promise<void> {
  header('[2] Funciones y vistas del planificador');
  const client = getSupabaseAdmin();

  // `register_skills` con lista vacía es un no-op idempotente: probarlo no escribe nada.
  const registered = await client.rpc('register_skills', { p_slugs: [] });
  if (registered.error !== null) {
    fail(`register_skills: ${registered.error.message} (¿falta db/migrations/0002_planner.sql?)`);
  } else {
    ok('register_skills disponible');
  }

  // `project_dag` es una FUNCIÓN jsonb, no una vista: se invoca por RPC. Con un uuid que
  // no existe devuelve el grafo vacío sin error, así que sirve de sonda sin escribir nada.
  const dag = await client.rpc('project_dag', {
    p_project_id: '00000000-0000-0000-0000-000000000000',
  });
  if (dag.error !== null) {
    fail(`project_dag: ${dag.error.message} (¿falta db/migrations/0002_planner.sql?)`);
  } else {
    ok('project_dag disponible');
  }

  // `task_dependencies` no se comprueba por columnas: el código NUNCA la escribe
  // directamente, siempre a través de `apply_project_plan`. El nombre de la columna de
  // destino varía entre despliegues (`depends_on_id` / `depends_on_task_id`) y afirmar uno
  // concreto producía un falso negativo. Lo que importa es que la RPC funcione.
  for (const column of ['depends_on_task_id', 'depends_on_id']) {
    const probe = await client.from('task_dependencies').select(`task_id, ${column}`).limit(0);
    if (probe.error === null) {
      info(`task_dependencies usa "${column}" como destino de la arista`);
      break;
    }
  }

  // `normalize_skill_slug` es pura: probarla no escribe nada y confirma la migración 0003.
  const normalized = await client.rpc('normalize_skill_slug', { p_raw: 'React 18' });
  if (normalized.error !== null) {
    fail(
      `normalize_skill_slug: ${normalized.error.message} ` +
        '(¿falta db/migrations/0003_provider_onboarding.sql?)',
    );
  } else if (normalized.data !== 'react-18') {
    fail(`normalize_skill_slug devolvió "${String(normalized.data)}", se esperaba "react-18"`);
  } else {
    ok('normalize_skill_slug disponible');
  }

  // `pending_qa_deliverables` es de solo lectura: sondearla confirma la migración 0005 sin
  // tocar ningún entregable.
  const queue = await client.rpc('pending_qa_deliverables', { p_limit: 1 });
  if (queue.error !== null) {
    fail(
      `pending_qa_deliverables: ${queue.error.message} ` +
        '(¿falta db/migrations/0005_qa.sql?)',
    );
  } else {
    ok('pending_qa_deliverables disponible');
  }

  info('apply_project_plan, resolve_or_create_skill, upsert_provider_profile,');
  info('  claim_deliverable_for_qa y apply_qa_verdict ESCRIBEN: se validan ejecutando');
  info('  `npm run plan`, `npm run provider:add` y `npm run qa`.');
}

async function checkSeedAndOwner(): Promise<void> {
  header('[3] Catálogo y propietario');
  const client = getSupabaseAdmin();

  const skills = await client
    .from('skills')
    .select('slug', { head: true, count: 'exact' })
    .eq('is_active', true);
  if (skills.error !== null) {
    fail(`catálogo de skills: ${skills.error.message}`);
  } else if ((skills.count ?? 0) === 0) {
    fail('el catálogo de skills está vacío: el planificador inventará slugs');
  } else {
    ok(`catálogo de skills: ${skills.count} activas`);
  }

  // Sin embeddings en el catálogo, `resolve_or_create_skill` no puede comparar nada y la
  // normalización semántica degrada a "slug exacto o skill nueva".
  const vectorized = await client
    .from('skills')
    .select('slug', { head: true, count: 'exact' })
    .eq('is_active', true)
    .not('embedding', 'is', null);
  if (vectorized.error !== null) {
    fail(`skills vectorizadas: ${vectorized.error.message}`);
  } else if ((vectorized.count ?? 0) === 0) {
    fail('ninguna skill está vectorizada: ejecuta `npm run skills:embed`');
  } else if ((vectorized.count ?? 0) < (skills.count ?? 0)) {
    fail(
      `solo ${vectorized.count}/${skills.count} skills vectorizadas: ` +
        'ejecuta `npm run skills:embed`',
    );
  } else {
    ok(`catálogo vectorizado: ${vectorized.count}/${skills.count}`);
  }

  const providers = await client
    .from('provider_profiles')
    .select('id', { head: true, count: 'exact' })
    .eq('is_active', true);
  if (providers.error !== null) {
    fail(`provider_profiles: ${providers.error.message}`);
  } else if ((providers.count ?? 0) === 0) {
    info('sin proveedores activos: el matching de la FASE 4 no tendrá a quién emparejar');
  } else {
    ok(`proveedores activos: ${providers.count}`);
  }

  const declared = process.env['VEKTORA_OWNER_ID']?.trim();
  if (declared !== undefined && declared !== '') {
    const owner = await client.from('users').select('id, email, status').eq('id', declared).maybeSingle();
    if (owner.error !== null) {
      fail(`VEKTORA_OWNER_ID: ${owner.error.message}`);
    } else if (owner.data === null) {
      fail(`VEKTORA_OWNER_ID=${declared} no existe en public.users`);
    } else {
      const row = owner.data as { email: string | null; status: string };
      if (row.status !== 'active') fail(`el propietario declarado está "${row.status}"`);
      else ok(`VEKTORA_OWNER_ID válido (${row.email ?? 'sin email'})`);
    }
    return;
  }

  const any = await client
    .from('users')
    .select('id, email', { count: 'exact' })
    .eq('status', 'active')
    .order('created_at', { ascending: true })
    .limit(1);
  if (any.error !== null) {
    fail(`public.users: ${any.error.message}`);
  } else if ((any.data ?? []).length === 0) {
    fail('no hay usuarios activos en public.users: `npm run plan` no tendrá propietario');
  } else {
    const row = (any.data ?? [])[0] as { id: string; email: string | null };
    ok(`sin VEKTORA_OWNER_ID; se usaría ${row.id} (${row.email ?? 'sin email'})`);
    info(`total de usuarios activos: ${any.count ?? '?'}`);
  }
}

async function checkEscaladaYCuotas(): Promise<void> {
  header('[4] Escalada y cuotas (FASE 7)');
  const client = getSupabaseAdmin();

  // `usage_events` es donde se cuentan las acciones que gastan IA. Sin ella, `consume_quota`
  // no existe y cada Server Action permitiría lo que quisiera.
  const eventos = await client
    .from('usage_events')
    .select('user_id, action, created_at')
    .limit(0);
  if (eventos.error !== null) {
    fail(
      `usage_events: ${eventos.error.message} ` +
        '(¿falta db/migrations/0007_escalada.sql?)',
    );
  } else {
    ok('usage_events disponible');
  }

  // `quota_usage` es STABLE: consultarla no consume ningún hueco. Con un uuid inexistente
  // devuelve 0 sin error, así que sirve de sonda sin efectos.
  const consumo = await client.rpc('quota_usage', {
    p_user_id: '00000000-0000-0000-0000-000000000000',
    p_action: 'crear_proyecto',
    p_window_hours: 24,
  });
  if (consumo.error !== null) {
    fail(
      `quota_usage: ${consumo.error.message} ` +
        '(¿falta db/migrations/0007_escalada.sql?)',
    );
  } else {
    ok('quota_usage disponible');
  }

  info('consume_quota y bump_matching_round ESCRIBEN: no se sondean aquí. Se validan');
  info('  ejecutando `npm run cron emparejar` y creando un proyecto desde la interfaz.');

  // La 0006 solo habilita las actualizaciones en vivo del grafo. No se puede comprobar
  // desde PostgREST —`pg_publication_tables` vive en el catálogo del sistema— y su ausencia
  // degrada en silencio: la interfaz funciona, pero hay que recargar para ver los cambios.
  info('db/migrations/0006_realtime.sql no es verificable desde aquí. Si el grafo no se');
  info('  actualiza solo y hay que recargar la página, es que falta aplicarla.');
}

async function main(): Promise<void> {
  console.log('\n══════════════════════════════════════════════════════');
  console.log(' VEKTORA · verificación del despliegue de la base');
  console.log('══════════════════════════════════════════════════════');

  if (!isSupabaseAdminConfigured()) {
    console.error(
      '\nFaltan SUPABASE_URL y/o SUPABASE_SERVICE_ROLE_KEY en .env.local ' +
        '(cópialas de env.example).\n',
    );
    process.exitCode = 1;
    return;
  }

  await checkTables();
  await checkRpcAndViews();
  await checkSeedAndOwner();
  await checkEscaladaYCuotas();

  console.log('\n══════════════════════════════════════════════════════');
  if (failures === 0) {
    console.log(' RESULTADO: la base tiene todo lo que necesita el código (FASES 1-7)');
  } else {
    console.log(` RESULTADO: ${failures} problema(s). Aplica, EN ORDEN, db/schema.sql y`);
    console.log('            db/migrations/0002 … 0007 en el SQL Editor de Supabase.');
    process.exitCode = 1;
  }
  console.log('══════════════════════════════════════════════════════\n');
}

main().catch((error: unknown) => {
  console.error(`\nVEKTORA/DB: la verificación falló -> ${errorMessage(error)}\n`);
  process.exitCode = 1;
});
