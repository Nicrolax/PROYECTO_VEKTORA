'use server';

/**
 * VEKTORA · FASE 6 — Registro de entregables (RF-5.2 a RF-5.5).
 *
 * La comprobación que importa está en la tercera línea de `entregarTrabajo`: solo el
 * proveedor ADJUDICADO puede entregar. No basta con tener sesión. Sin eso, cualquiera con
 * el identificador de una tarea podría inyectar un entregable ajeno y cobrar su reputación.
 *
 * La evidencia se guarda como un objeto con una clave por criterio. Esa correspondencia es
 * lo que hace fiable al evaluador: no se le pide que adivine qué parte del trabajo responde
 * a qué criterio, se le dice.
 */

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { errorMessage } from '@/lib/ai/errors';
import { requireUserOrThrow } from '@/lib/auth/session';
import { consumirCuota } from '@/lib/cuotas';
import { getSupabaseAdmin } from '@/lib/supabase/admin';

const EntregaSchema = z.object({
  taskId: z.string().uuid('Identificador de tarea inválido'),
  summary: z
    .string()
    .trim()
    .min(10, 'El resumen necesita al menos 10 caracteres')
    .max(2000, 'El resumen es demasiado largo'),
  content: z
    .string()
    .trim()
    .min(1, 'Hace falta entregar algo: el evaluador no aprueba nada sin evidencia')
    .max(200_000, 'El contenido supera el máximo admitido'),
});

export interface ResultadoEntrega {
  ok: boolean;
  error: string | null;
  faltantes: string[];
}

export async function entregarTrabajo(
  _estadoPrevio: ResultadoEntrega,
  formData: FormData,
): Promise<ResultadoEntrega> {
  const user = await requireUserOrThrow();

  const parsed = EntregaSchema.safeParse({
    taskId: formData.get('taskId'),
    summary: formData.get('summary'),
    content: formData.get('content'),
  });
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? 'Los datos no son válidos',
      faltantes: [],
    };
  }

  const admin = getSupabaseAdmin();

  const { data: tarea, error: errorTarea } = await admin
    .from('project_tasks')
    .select('id, project_id, assignee_id, acceptance_criteria, status')
    .eq('id', parsed.data.taskId)
    .maybeSingle();

  if (errorTarea !== null || tarea === null) {
    return { ok: false, error: 'La tarea no existe', faltantes: [] };
  }

  const fila = tarea as unknown as {
    project_id: string;
    assignee_id: string | null;
    acceptance_criteria: Array<{ id?: unknown }>;
  };

  // La comprobación que de verdad protege: tener sesión no alcanza.
  if (fila.assignee_id !== user.id) {
    return {
      ok: false,
      error: 'Esta tarea está adjudicada a otro proveedor',
      faltantes: [],
    };
  }

  const identificadores = (Array.isArray(fila.acceptance_criteria) ? fila.acceptance_criteria : [])
    .map((criterio) => (typeof criterio.id === 'string' ? criterio.id : null))
    .filter((id): id is string => id !== null);

  const evidencia: Record<string, string> = {};
  const faltantes: string[] = [];
  for (const identificador of identificadores) {
    const valor = formData.get(`evidencia:${identificador}`);
    const texto = typeof valor === 'string' ? valor.trim() : '';
    if (texto === '') faltantes.push(identificador);
    else evidencia[identificador] = texto;
  }

  // Los criterios sin evidencia se avisan pero NO bloquean la entrega: el evaluador los
  // juzgará contra el contenido general, con menos confianza. Impedir entregar sería peor
  // que entregar desalineado (RF-5.4).
  if (faltantes.length > 0 && formData.get('confirmar') !== 'si') {
    return { ok: false, error: null, faltantes };
  }

  // Entregar es barato, pero cada entrega dispara una evaluación, que no lo es.
  const cuota = await consumirCuota(user.id, 'entregar');
  if (!cuota.permitido) return { ok: false, error: cuota.mensaje, faltantes: [] };

  const { data: entregable, error: errorEntrega } = await admin
    .from('deliverables')
    .insert({
      task_id: parsed.data.taskId,
      provider_id: user.id,
      summary: parsed.data.summary,
      content: parsed.data.content,
      artifacts: [],
      evidence: evidencia,
    })
    .select('id')
    .single();

  if (errorEntrega !== null) {
    return { ok: false, error: errorMessage(errorEntrega), faltantes: [] };
  }

  // Si el cambio de estado falla, la entrega ya está escrita y el evaluador la recogerá
  // igual desde la cola. Se prefiere un estado desactualizado a perder el trabajo.
  await admin
    .from('project_tasks')
    .update({ status: 'submitted' })
    .eq('id', parsed.data.taskId)
    .in('status', ['assigned', 'in_progress', 'revision_requested']);

  revalidatePath(`/proyectos/${fila.project_id}`);
  revalidatePath(`/tareas/${parsed.data.taskId}`);
  redirect(`/tareas/${parsed.data.taskId}?entregado=${(entregable as { id: string }).id}`);
}
