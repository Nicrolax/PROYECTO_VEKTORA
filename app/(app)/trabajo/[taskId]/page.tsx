import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { requireUser } from '@/lib/auth/session';
import { getSupabaseServer } from '@/lib/supabase/server';
import { toNumber, type PgNumeric } from '@/lib/supabase/types';
import { Dato, Dinero, Insignia, Panel } from '@/components/ui/primitivas';
import { FormularioEntrega } from './formulario';

export const metadata = { title: 'Entregar trabajo · VEKTORA' };

export default async function Workspace({ params }: { params: Promise<{ taskId: string }> }) {
  const user = await requireUser();
  const { taskId } = await params;
  const supabase = await getSupabaseServer();

  const { data, error } = await supabase
    .from('project_tasks')
    .select(
      'id, project_id, code, title, description, acceptance_criteria, status, budget, estimated_hours, assignee_id, projects!inner(title, objective)',
    )
    .eq('id', taskId)
    .maybeSingle();

  if (error !== null || data === null) notFound();

  const tarea = data as unknown as {
    project_id: string;
    code: string;
    title: string;
    description: string | null;
    acceptance_criteria: Array<{ id: string; criterion: string; verification?: string }>;
    status: string;
    budget: PgNumeric | null;
    estimated_hours: PgNumeric | null;
    assignee_id: string | null;
    projects: { title: string; objective: string } | { title: string; objective: string }[];
  };

  // El espacio de entrega es del proveedor adjudicado. Al resto se le devuelve al detalle
  // de la tarea, que sí puede ver.
  if (tarea.assignee_id !== user.id) redirect(`/tareas/${taskId}`);

  const proyecto = Array.isArray(tarea.projects) ? tarea.projects[0] : tarea.projects;
  const criterios = Array.isArray(tarea.acceptance_criteria) ? tarea.acceptance_criteria : [];

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header className="space-y-3">
        <Link
          href={`/tareas/${taskId}`}
          className="text-xs text-[var(--color-apagado)] transition-colors hover:text-[var(--color-tenue)]"
        >
          ← {tarea.code} · {tarea.title}
        </Link>
        <div className="space-y-2">
          <h1 className="text-xl font-semibold tracking-tight text-balance">Entregar trabajo</h1>
          <Insignia estado={tarea.status} />
        </div>
      </header>

      <Panel className="p-4">
        <p className="text-xs text-[var(--color-apagado)]">Contexto del proyecto</p>
        <p className="mt-1.5 text-sm leading-relaxed text-[var(--color-tenue)]">
          {proyecto?.objective}
        </p>
        {tarea.description !== null && (
          <p className="mt-3 border-t border-[var(--color-borde)] pt-3 text-sm leading-relaxed">
            {tarea.description}
          </p>
        )}
        <dl className="mt-4 grid grid-cols-2 gap-4 border-t border-[var(--color-borde)] pt-4 sm:grid-cols-3">
          <Dato etiqueta="Pago" valor={<Dinero valor={toNumber(tarea.budget)} />} />
          <Dato etiqueta="Esfuerzo" valor={`${toNumber(tarea.estimated_hours) ?? '—'} h`} />
          <Dato etiqueta="Criterios" valor={String(criterios.length)} />
        </dl>
      </Panel>

      <Panel className="p-5">
        <FormularioEntrega taskId={taskId} criterios={criterios} />
      </Panel>

      <p className="text-xs leading-relaxed text-[var(--color-apagado)]">
        Al entregar, la tarea entra en la cola de evaluación automática. El evaluador
        comprueba cada criterio por separado y cita la parte de tu evidencia que lo
        demuestra. Si algo no se puede verificar, pide cambios en lugar de rechazar.
      </p>
    </div>
  );
}
