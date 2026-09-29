/**
 * VEKTORA · FASE 6 — Evaluación periódica de entregables (RF-6.10).
 *
 * La cola sale de `pending_qa_deliverables`, que ordena del más antiguo al más reciente: sin
 * un orden estable, un entregable desafortunado podría esperar para siempre mientras llegan
 * otros.
 *
 * El juez toma cada entregable de forma exclusiva, así que dos corridas solapadas no pueden
 * juzgar lo mismo ni acreditar la reputación dos veces.
 */

import { NextResponse } from 'next/server';
import { autorizarCron } from '@/lib/cron/autorizacion';
import { createQaJudge } from '@/lib/qa';

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

const MAXIMO_POR_CORRIDA = 10;

export async function POST(request: Request): Promise<NextResponse> {
  const autorizacion = autorizarCron(request.headers);
  if (!autorizacion.autorizado) {
    return NextResponse.json({ error: autorizacion.motivo }, { status: autorizacion.estado });
  }

  const resultados = await createQaJudge().judgeQueue(MAXIMO_POR_CORRIDA);

  return NextResponse.json({
    evaluados: resultados.length,
    conVeredicto: resultados.filter((resultado) => resultado.judged).length,
    detalle: resultados.map((resultado) => ({
      entregable: resultado.deliverableId,
      tarea: resultado.claim?.task.code ?? null,
      veredicto: resultado.decision?.qaStatus ?? null,
      puntuacion: resultado.decision?.score ?? null,
      motivo: resultado.reason,
    })),
  });
}

export async function GET(request: Request): Promise<NextResponse> {
  const autorizacion = autorizarCron(request.headers);
  return autorizacion.autorizado
    ? NextResponse.json({ listo: true, trabajo: 'evaluar' })
    : NextResponse.json({ error: autorizacion.motivo }, { status: autorizacion.estado });
}
