import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireUser } from '@/lib/auth/session';
import { getSupabaseServer } from '@/lib/supabase/server';
import { toNumber, type PgNumeric } from '@/lib/supabase/types';
import { presentarProyecto } from '@/components/estados';
import { Dinero } from '@/components/ui/primitivas';
import type { TareaGrafo } from '@/components/grafo/disposicion';
import { VistaProyecto } from './vista';

interface FilaTarea {
  id: string;
  code: string;
  title: string;
  status: string;
  budget: PgNumeric | null;
  assignee_id: string | null;
}

export default async function DetalleProyecto({ params }: { params: Promise<{ id: string }> }) {
  await requireUser();
  const { id } = await params;
  const supabase = await getSupabaseServer();

  const [proyecto, tareas] = await Promise.all([
    supabase
      .from('projects')
      .select('id, title, objective, status, budget_total, currency')
      .eq('id', id)
      .maybeSingle(),
    supabase
      .from('project_tasks')
      .select('id, code, title, status, budget, assignee_id')
      .eq('project_id', id)
      .order('order_index', { ascending: true }),
  ]);

  // Sin fila significa que no existe o que las políticas no dejan verlo. La interfaz
  // responde igual en ambos casos: revelar la diferencia permitiría averiguar qué
  // proyectos existen.
  if (proyecto.error !== null || proyecto.data === null) notFound();

  const filas = (tareas.data ?? []) as unknown as FilaTarea[];
  const porId = new Map(filas.map((fila) => [fila.id, fila.code]));

  const { data: aristas } = await supabase
    .from('task_dependencies')
    .select('task_id, depends_on_task_id')
    .in('task_id', filas.map((fila) => fila.id));

  const dependencias = new Map<string, string[]>();
  for (const arista of (aristas ?? []) as { task_id: string; depends_on_task_id: string }[]) {
    const origen = porId.get(arista.depends_on_task_id);
    if (origen === undefined) continue;
    const bucket = dependencias.get(arista.task_id) ?? [];
    bucket.push(origen);
    dependencias.set(arista.task_id, bucket);
  }

  const paraGrafo: TareaGrafo[] = filas.map((fila) => ({
    id: fila.id,
    code: fila.code,
    title: fila.title,
    status: fila.status,
    dependsOn: dependencias.get(fila.id) ?? [],
    assigneeId: fila.assignee_id,
    budget: toNumber(fila.budget),
  }));

  const datos = proyecto.data as unknown as {
    title: string;
    objective: string;
    status: string;
    budget_total: PgNumeric | null;
    currency: string;
  };

  return (
    <div className="space-y-6">
      <header className="space-y-3">
        <Link
          href="/panel"
          className="text-xs text-[var(--color-apagado)] transition-colors hover:text-[var(--color-tenue)]"
        >
          ← Mis proyectos
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h1 className="text-xl font-semibold tracking-tight text-balance">{datos.title}</h1>
            <p className="max-w-2xl text-sm leading-relaxed text-[var(--color-apagado)]">
              {datos.objective}
            </p>
          </div>
          <div className="flex items-end gap-5">
          <dl className="flex gap-6 text-right">
            <div>
              <dt className="text-xs text-[var(--color-apagado)]">Estado</dt>
              <dd className="text-sm">{presentarProyecto(datos.status)}</dd>
            </div>
            <div>
              <dt className="text-xs text-[var(--color-apagado)]">Presupuesto</dt>
              <dd className="text-sm">
                <Dinero valor={toNumber(datos.budget_total)} moneda={datos.currency ?? 'USD'} />
              </dd>
            </div>
          </dl>
          <Link
            href={`/proyectos/${id}/consumo`}
            className="boton boton-suave !px-3 !py-1.5 !text-xs"
          >
            Consumo de IA
          </Link>
          </div>
        </div>
      </header>

      <VistaProyecto projectId={id} tareas={paraGrafo} />
    </div>
  );
}
