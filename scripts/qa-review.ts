/**
 * VEKTORA · FASE 5 — Agente autónomo de QA sobre entregables reales.
 *
 *   npm run qa                             # cola de entregables esperando veredicto
 *   npm run qa -- <deliverable_id>         # juzga uno y escribe el veredicto
 *   npm run qa -- <deliverable_id> --dry-run
 *   npm run qa -- --task <task_id>         # juzga el último entregable de esa tarea
 *   npm run qa -- --all                    # juzga la cola entera
 *
 * Imprime el veredicto criterio a criterio con la evidencia citada. Un veredicto sin esa
 * traza es indefendible: el sistema cierra tareas y mueve reputación sin que nadie lo
 * apruebe, así que cada decisión tiene que poder explicarse después.
 */

import '@/lib/env';

import { errorMessage } from '@/lib/ai/errors';
import { createQaJudge, getQaConfig, type JudgeResult } from '@/lib/qa';
import { isSupabaseAdminConfigured } from '@/lib/supabase/admin';

function line(label: string, value: string): void {
  console.log(`  ${label.padEnd(24)} ${value}`);
}

const ICON: Record<string, string> = { pass: '✓', fail: '✗', unverifiable: '?' };

async function showQueue(): Promise<void> {
  const pending = await createQaJudge().queue();
  if (pending.length === 0) {
    console.log(
      '\nNo hay entregables esperando veredicto.\n' +
        'Envía uno con:  npm run deliver -- <task_id> <archivo.json>\n',
    );
    return;
  }

  console.log('\nEntregables en cola (más antiguo primero):\n');
  for (const entry of pending) {
    console.log(`  ${entry.deliverableId}`);
    console.log(
      `    ${entry.taskCode} · ${entry.taskTitle}  v${entry.version}  ` +
        `[${entry.qaStatus}]  ${entry.criteriaCount} criterio(s)`,
    );
  }
  console.log('\nJuzgar:  npm run qa -- <deliverable_id>\n');
}

function report(result: JudgeResult): void {
  const claim = result.claim;

  console.log('\n=== VEKTORA · FASE 5 · AI Judge ===\n');

  if (claim === null) {
    console.log('[!] No se pudo juzgar');
    line('entregable:', result.deliverableId);
    line('motivo:', result.reason ?? 'desconocido');
    console.log();
    return;
  }

  const config = getQaConfig();
  console.log('[0] Política');
  line('aprueba con:', `${config.approveScore} / 100`);
  line('rechaza por debajo de:', `${config.revisionFloor} / 100`);
  line('confianza mínima:', String(config.minConfidence));
  line('intentos máximos:', String(config.maxAttempts));

  console.log('\n[1] Entregable');
  line('tarea:', `${claim.task.code} · ${claim.task.title}`);
  line('versión (intento):', String(claim.deliverable.version));
  line('estado previo:', claim.previousStatus);
  line('criterios:', String(result.criteria.length));
  if (result.malformedCriteria > 0) {
    line('criterios ilegibles:', `${result.malformedCriteria} (se ignoraron)`);
  }
  line(
    'evidencia estructurada:',
    String(Object.keys(claim.deliverable.evidence).length) + ' entrada(s)',
  );

  console.log('\n[2] Juez');
  if (result.skippedAi) {
    line('modelo:', 'no se llamó: el caso se resuelve por regla dura');
  } else {
    line('proveedor / modelo:', `${result.provider ?? '?'} · ${result.model ?? '?'}`);
    line('reparaciones Zod:', String(result.repairs));
    line('coste / latencia:', `${result.costUsd.toFixed(6)} USD · ${result.latencyMs} ms`);
    line('ai_runs:', result.runId ?? 'sin telemetría');
  }

  const decision = result.decision;
  if (decision === null) {
    console.log('\n[!] Sin veredicto');
    line('motivo:', result.reason ?? 'desconocido');
    console.log();
    return;
  }

  console.log('\n[3] Criterios');
  if (decision.criteria.length === 0) {
    console.log('  (ninguno evaluado)');
  }
  for (const criterion of decision.criteria) {
    const icon = ICON[criterion.outcome] ?? '·';
    console.log(`\n  ${icon} ${criterion.id}  ${criterion.criterion}`);
    console.log(
      `      veredicto ${criterion.outcome}` +
        (criterion.downgraded
          ? `  (el modelo dijo ${criterion.reported}, degradado por confianza ` +
            `${criterion.confidence.toFixed(2)})`
          : `  confianza ${criterion.confidence.toFixed(2)}`),
    );
    console.log(`      evidencia: ${criterion.evidence}`);
    console.log(`      razón:     ${criterion.reasoning}`);
  }

  const counts = decision.explanation.counts;
  console.log('\n[4] Veredicto');
  line('cumplidos:', `${counts.passed} / ${counts.total}`);
  if (counts.failed > 0) line('incumplidos:', String(counts.failed));
  if (counts.unverifiable > 0) line('sin evidencia:', String(counts.unverifiable));
  line('puntuación:', `${decision.score.toFixed(2)} / 100`);
  line('valoración:', `${decision.rating.toFixed(2)} / 5`);
  line('estado QA:', decision.qaStatus);
  line('estado de la tarea:', decision.taskStatus);
  if (decision.explanation.escalated) {
    line('escalado:', `intento ${decision.explanation.attempt}: se agotaron las revisiones`);
  }

  if (decision.explanation.blockingIssues.length > 0) {
    console.log('\n  Lo que impide aceptarlo:');
    for (const issue of decision.explanation.blockingIssues) console.log(`   · ${issue}`);
  }
  console.log(`\n  Resumen para el proveedor:\n  ${decision.explanation.summary}`);

  if (decision.reputation.length > 0) {
    console.log('\n[5] Reputación');
    for (const event of decision.reputation) {
      const sign = event.delta >= 0 ? '+' : '';
      line(`${event.event_type}:`, `${sign}${event.delta}  (${event.reason})`);
    }
  } else {
    console.log('\n[5] Reputación');
    console.log('  sin movimientos: pedir cambios es parte normal del ciclo de trabajo');
  }

  console.log('\n[6] Resultado');
  if (result.dryRun) {
    line('modo:', 'ensayo: no se escribió nada');
  } else if (result.applied !== null && result.applied.applied) {
    line('aplicado:', 'sí, en una transacción');
    line('reseña:', result.applied.reviewId ?? '?');
    line('eventos escritos:', String(result.applied.reputationWritten));
    if (result.applied.reputationSkipped.length > 0) {
      line('eventos omitidos:', result.applied.reputationSkipped.join(', ') + ' (ya cobrados)');
    }
    if (decision.taskStatus === 'approved') {
      line('DAG:', 'las tareas que dependían de esta se han recalculado');
    }
  } else {
    line('aplicado:', `no -> ${result.reason ?? 'motivo desconocido'}`);
  }
  console.log('\n=== Fin ===\n');
}

async function main(): Promise<void> {
  if (!isSupabaseAdminConfigured()) {
    console.error('\nFaltan SUPABASE_URL y/o SUPABASE_SERVICE_ROLE_KEY en .env.local.\n');
    process.exitCode = 1;
    return;
  }

  const args = process.argv.slice(2).filter((arg) => arg !== '***');
  const dryRun = args.includes('--dry-run');
  const positional = args.filter((arg) => !arg.startsWith('--'));

  const judge = createQaJudge();

  if (args.includes('--all')) {
    const results = await judge.judgeQueue(undefined, dryRun);
    if (results.length === 0) {
      console.log('\nLa cola está vacía.\n');
      return;
    }
    for (const result of results) report(result);
    const judged = results.filter((result) => result.judged).length;
    console.log(`Cola procesada: ${judged}/${results.length} con veredicto.\n`);
    return;
  }

  const taskFlag = args.indexOf('--task');
  if (taskFlag !== -1) {
    const taskId = args[taskFlag + 1];
    if (taskId === undefined || taskId.startsWith('--')) {
      console.error('\n--task necesita el id de la tarea.\n');
      process.exitCode = 1;
      return;
    }
    const { SupabaseQaRepository } = await import('@/lib/qa');
    const { getSupabaseAdmin } = await import('@/lib/supabase/admin');
    const deliverableId = await new SupabaseQaRepository(
      getSupabaseAdmin(),
    ).latestDeliverableForTask(taskId);
    if (deliverableId === null) {
      console.error(`\nLa tarea ${taskId} no tiene ningún entregable.\n`);
      process.exitCode = 1;
      return;
    }
    report(await judge.judge({ deliverableId, dryRun }));
    return;
  }

  const deliverableId = positional[0];
  if (deliverableId === undefined) {
    await showQueue();
    return;
  }

  report(await judge.judge({ deliverableId, dryRun }));
}

main().catch((error: unknown) => {
  console.error(`\nVEKTORA/QA: falló -> ${errorMessage(error)}\n`);
  process.exitCode = 1;
});
