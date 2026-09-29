/**
 * VEKTORA · FASE 4 — Matching híbrido de una tarea real.
 *
 *   npm run match                          # lista las tareas que esperan proveedor
 *   npm run match -- <task_id>             # calcula y escribe el shortlist
 *   npm run match -- <task_id> --dry-run   # calcula sin escribir nada
 *   npm run match -- <task_id> --assign    # adjudica si el mejor supera el umbral
 *   npm run match -- <task_id> --manual    # incluye a quien NO acepta asignación automática
 *
 * Imprime el desglose completo de cada candidato: sin eso, una adjudicación automática es
 * una caja negra, y la regla 1 del proyecto solo es defendible si cada decisión se puede
 * auditar después.
 */

import '@/lib/env';

import { errorMessage } from '@/lib/ai/errors';
import { getMatchingConfig } from '@/lib/matching';
import { createTaskMatcher } from '@/lib/matching';
import { getSupabaseAdmin, isSupabaseAdminConfigured } from '@/lib/supabase/admin';

function line(label: string, value: string): void {
  console.log(`  ${label.padEnd(24)} ${value}`);
}

async function listPendingTasks(): Promise<void> {
  // Se listan TODAS las tareas sin asignar, no solo las `ready`: si el DAG dejó todo en
  // `blocked` esperando dependencias, decir "no hay tareas" sería engañoso — las hay, y lo
  // que falta es aprobar las de arriba.
  const { data, error } = await getSupabaseAdmin()
    .from('project_tasks')
    .select('id, code, title, status, required_skills, budget, projects!inner(title)')
    .is('assignee_id', null)
    .in('status', ['blocked', 'ready', 'open', 'matching'])
    .order('created_at', { ascending: true })
    .limit(40);

  if (error !== null) {
    console.error(`\nNo se pudieron leer las tareas -> ${error.message}\n`);
    process.exitCode = 1;
    return;
  }

  const rows = (data ?? []) as unknown as Array<Record<string, unknown>>;
  if (rows.length === 0) {
    console.log(
      '\nNo hay ninguna tarea sin asignar. Crea un proyecto con:\n' +
        '  npm run plan -- "<objetivo en lenguaje natural>" [presupuesto]\n',
    );
    return;
  }

  const emparejables = rows.filter((row) =>
    ['ready', 'open', 'matching'].includes(String(row['status'])),
  );

  console.log('\nTareas sin asignar:\n');
  for (const row of rows) {
    const project = row['projects'];
    const projectTitle = Array.isArray(project)
      ? String((project[0] as { title?: unknown })?.title ?? '')
      : String((project as { title?: unknown } | null)?.title ?? '');
    const skills = Array.isArray(row['required_skills'])
      ? (row['required_skills'] as string[]).join(',')
      : '';
    console.log(
      `  ${String(row['id'])}  ${String(row['code']).padEnd(7)} ` +
        `${String(row['status']).padEnd(9)} ${skills.padEnd(30)} ${String(row['title'])}`,
    );
    console.log(`  ${' '.repeat(36)}  proyecto: ${projectTitle}`);
  }
  if (emparejables.length === 0) {
    console.log(
      '\nTodas están en `blocked`: esperan a que se apruebe alguna dependencia del DAG.\n' +
        'Solo las `ready`, `open` o `matching` se pueden emparejar.\n\n' +
        'Para desbloquear la raíz del grafo puedes aprobarla a mano en Supabase:\n' +
        "  update public.project_tasks set status = 'approved' where id = '<task_id>';\n" +
        'El trigger `refresh_task_readiness` pasará sus dependientes a `ready` solo.\n',
    );
    return;
  }

  console.log(`\n${emparejables.length} emparejable(s). Usa: npm run match -- <task_id>\n`);
}

/**
 * Por qué la recuperación devolvió cero candidatos.
 *
 * `match_task_candidates` aplica cinco filtros de elegibilidad y devuelve una lista vacía
 * sin decir cuál actuó. En un sistema que adjudica solo, "no hay nadie" y "los hay pero
 * ninguno es elegible" son diagnósticos muy distintos.
 */
async function explainNoCandidates(taskId: string, includeManualOnly: boolean): Promise<void> {
  const client = getSupabaseAdmin();

  const task = await client
    .from('project_tasks')
    .select('budget, projects!inner(owner_id)')
    .eq('id', taskId)
    .maybeSingle();
  if (task.error !== null || task.data === null) return;

  const row = task.data as unknown as Record<string, unknown>;
  const project = row['projects'];
  const ownerId = String(
    (Array.isArray(project) ? project[0] : project as { owner_id?: unknown } | null)?.owner_id ?? '',
  );
  const budget = row['budget'] === null ? null : Number(row['budget']);

  const profiles = await client
    .from('provider_profiles')
    .select('id, user_id, headline, is_active, accepts_auto_assign, min_task_budget_usd');
  if (profiles.error !== null) return;

  const all = (profiles.data ?? []) as Array<{
    id: string;
    user_id: string;
    headline: string | null;
    is_active: boolean;
    accepts_auto_assign: boolean;
    min_task_budget_usd: number | string | null;
  }>;

  const resolved = await client
    .from('task_applications')
    .select('provider_id')
    .eq('task_id', taskId)
    .in('status', ['accepted', 'rejected', 'withdrawn', 'expired']);
  const excludedByApplication = new Set(
    ((resolved.data ?? []) as Array<{ provider_id: string }>).map((entry) => entry.provider_id),
  );

  console.log('[2b] Por qué no hubo candidatos');
  line('perfiles de proveedor:', String(all.length));

  if (all.length === 0) {
    console.log('\n  No hay ningún perfil de proveedor en la base.');
    console.log('  Da de alta uno con: npm run provider:add -- <perfil.json>\n');
    return;
  }

  const reasons: string[] = [];
  for (const profile of all) {
    const name = profile.headline ?? profile.user_id;
    const causes: string[] = [];
    if (!profile.is_active) causes.push('perfil inactivo');
    if (profile.user_id === ownerId) {
      causes.push('ES EL DUEÑO del proyecto: no puede ser proveedor de su propia tarea');
    }
    if (!includeManualOnly && !profile.accepts_auto_assign) {
      causes.push('no acepta asignación automática (usa --manual para incluirlo)');
    }
    const minBudget =
      profile.min_task_budget_usd === null ? null : Number(profile.min_task_budget_usd);
    if (budget !== null && minBudget !== null && minBudget > budget) {
      causes.push(`pide un mínimo de ${minBudget} y la tarea paga ${budget}`);
    }
    if (excludedByApplication.has(profile.user_id)) {
      causes.push('ya tiene una candidatura resuelta para esta tarea');
    }
    if (causes.length > 0) reasons.push(`  · ${name}: ${causes.join('; ')}`);
  }

  if (reasons.length === 0) {
    console.log('\n  Ningún filtro obvio los excluye. Revisa manualmente la RPC.\n');
    return;
  }
  console.log();
  for (const reason of reasons) console.log(reason);
  console.log();
}

async function main(): Promise<void> {
  if (!isSupabaseAdminConfigured()) {
    console.error('\nFaltan SUPABASE_URL y/o SUPABASE_SERVICE_ROLE_KEY en .env.local.\n');
    process.exitCode = 1;
    return;
  }

  const args = process.argv.slice(2);
  const taskId = args.find((arg) => !arg.startsWith('--'));
  if (taskId === undefined) {
    await listPendingTasks();
    return;
  }

  const dryRun = args.includes('--dry-run');
  const assign = args.includes('--assign');
  const includeManualOnly = args.includes('--manual');
  const config = getMatchingConfig();

  console.log('\n=== VEKTORA · FASE 4 · matching híbrido ===\n');
  console.log('[0] Configuración');
  line(
    'pesos:',
    `vector ${config.weights.vector} · skill ${config.weights.skill} · ` +
      `reputación ${config.weights.reputation}`,
  );
  line('recalibración vector:', `[${config.vector.floor}, ${config.vector.ceiling}] -> [0, 1]`);
  line('umbrales:', `score ≥ ${config.minScore} · adjudicación ≥ ${config.autoAssignMin}`);
  line('shortlist:', `${config.shortlist} de ${config.candidateLimit} candidatos`);
  console.log();

  const started = Date.now();
  const result = await createTaskMatcher().matchTask({
    taskId,
    assign,
    includeManualOnly,
    dryRun,
  });

  console.log('[1] Tarea');
  line('código / título:', `${result.task.code} · ${result.task.title}`);
  line('estado:', result.task.status);
  line('skills requeridas:', result.task.requiredSkills.join(', ') || '(ninguna)');
  line(
    'presupuesto / horas:',
    `${result.task.budget ?? '-'} / ${result.task.estimatedHours ?? '-'} h`,
  );
  if (result.taskEmbedded) line('embedding:', 'generado en esta corrida');
  console.log();

  console.log('[2] Candidatos');
  line('recuperados:', String(result.candidates));
  line('en shortlist:', String(result.shortlist.length));
  line('descartados:', String(result.rejected.length));
  if (result.degraded && result.candidates > 0) {
    line('aviso:', 'sin embeddings: ranking puramente determinista');
  }
  console.log();

  // Cero candidatos no dice nada por sí solo: hay cinco filtros duros y hay que saber
  // CUÁL excluyó a quién. Sin esto, el motor parece roto cuando en realidad funciona.
  if (result.candidates === 0) {
    await explainNoCandidates(result.task.id, includeManualOnly);
  }

  if (result.shortlist.length > 0) {
    console.log('[3] Ranking');
    result.shortlist.forEach((candidate, index) => {
      const explanation = candidate.explanation;
      console.log(
        `\n  #${index + 1}  match ${candidate.matchScore.toFixed(4)}  ` +
          `${candidate.headline ?? candidate.userId}`,
      );
      console.log(`      provider ${candidate.userId}`);
      console.log(
        `      vector ${candidate.vectorScore === null ? '  n/d ' : candidate.vectorScore.toFixed(4)}` +
          ` (reescalado ${explanation.vector.rescaled?.toFixed(4) ?? 'n/d'})` +
          `   skill ${candidate.skillScore.toFixed(4)}` +
          `   reputación ${candidate.reputationScore.toFixed(4)}`,
      );
      console.log(`      ${explanation.summary}`);
    });
    console.log();
  }

  if (result.rejected.length > 0) {
    console.log('[4] Descartados');
    for (const rejected of result.rejected) {
      console.log(
        `  · ${(rejected.headline ?? rejected.userId).padEnd(46)} [${rejected.reason}]`,
      );
      console.log(`    ${rejected.detail}`);
    }
    console.log();
  }

  console.log('[5] Resultado');
  if (dryRun) {
    line('modo:', 'dry-run: no se escribió nada');
  } else {
    line('candidaturas escritas:', String(result.written));
  }
  if (result.assigned !== null) {
    // Esta línea es el registro de a quién se le dio el trabajo sin que nadie lo decidiera.
    // Un uuid suelto obliga a ir a la base para auditarla, que es justo cuando no se hace.
    const winner = result.shortlist.find(
      (candidate) => candidate.userId === result.assigned?.providerId,
    );
    line('ADJUDICADA a:', winner?.headline ?? result.assigned.providerId);
    if (winner?.headline != null) line('', result.assigned.providerId);
  } else if (result.assignmentSkipped !== null) {
    line('sin adjudicar:', result.assignmentSkipped);
  }
  line('tiempo total:', `${Date.now() - started} ms`);

  console.log('\n=== Fin ===\n');
}

main().catch((error: unknown) => {
  console.error(`\nVEKTORA/MATCH: falló -> ${errorMessage(error)}\n`);
  process.exitCode = 1;
});
