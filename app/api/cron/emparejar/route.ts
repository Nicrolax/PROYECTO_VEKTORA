/**
 * VEKTORA · FASE 6 — Emparejamiento periódico (RF-4.9).
 *
 * Esto es lo que convierte al sistema en autónomo de verdad. Sin un disparador periódico,
 * una tarea que queda disponible espera a que alguien ejecute algo — y eso es intervención
 * humana, aunque se llame «pulsar un botón».
 *
 * Un fallo en una tarea no detiene a las demás: el mercado de una no dice nada del de otra.
 */

import { NextResponse } from 'next/server';
import { errorMessage } from '@/lib/ai/errors';
import { autorizarCron } from '@/lib/cron/autorizacion';
import { createTaskMatcher } from '@/lib/matching';
import { getSupabaseAdmin } from '@/lib/supabase/admin';

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

const MAXIMO_POR_CORRIDA = 10;

export async function POST(request: Request): Promise<NextResponse> {
  const autorizacion = autorizarCron(request.headers);
  if (!autorizacion.autorizado) {
    return NextResponse.json({ error: autorizacion.motivo }, { status: autorizacion.estado });
  }

  const { data, error } = await getSupabaseAdmin()
    .from('project_tasks')
    .select('id, code, projects!inner(title)')
    .is('assignee_id', null)
    .in('status', ['ready', 'open', 'matching'])
    .order('created_at', { ascending: true })
    .limit(MAXIMO_POR_CORRIDA);

  if (error !== null) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const pendientes = (data ?? []) as unknown as Array<{
    id: string;
    code: string;
    projects: { title: string } | { title: string }[];
  }>;
  const matcher = createTaskMatcher();
  const resultados: Array<Record<string, unknown>> = [];

  for (const tarea of pendientes) {
    try {
      const resultado = await matcher.matchTask({ taskId: tarea.id, assign: true });
      const proyecto = Array.isArray(tarea.projects) ? tarea.projects[0] : tarea.projects;
      resultados.push({
        code: tarea.code,
        // Dos proyectos pueden tener su propia T-01; sin el título, la traza es ambigua.
        proyecto: proyecto?.title ?? null,
        candidatos: resultado.candidates,
        adjudicada: resultado.assigned !== null,
        escalada: resultado.escalated,
        motivo: resultado.assignmentSkipped,
      });
    } catch (causa) {
      resultados.push({ code: tarea.code, error: errorMessage(causa) });
    }
  }

  return NextResponse.json({
    revisadas: pendientes.length,
    adjudicadas: resultados.filter((r) => r['adjudicada'] === true).length,
    detalle: resultados,
  });
}

/** GET para poder comprobar el estado del disparador sin ejecutar nada. */
export async function GET(request: Request): Promise<NextResponse> {
  const autorizacion = autorizarCron(request.headers);
  return autorizacion.autorizado
    ? NextResponse.json({ listo: true, trabajo: 'emparejar' })
    : NextResponse.json({ error: autorizacion.motivo }, { status: autorizacion.estado });
}
