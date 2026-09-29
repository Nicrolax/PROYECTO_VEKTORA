import Link from 'next/link';
import { requireUser } from '@/lib/auth/session';
import { getSupabaseServer } from '@/lib/supabase/server';
import { Avance, Dinero, EnlaceBoton, Vacio } from '@/components/ui/primitivas';
import { presentarProyecto } from '@/components/estados';
import { toNumber, type PgNumeric } from '@/lib/supabase/types';

export const metadata = { title: 'Mis proyectos' };

interface FilaProyecto {
  id: string;
  title: string;
  objective: string;
  status: string;
  budget_total: PgNumeric | null;
  currency: string;
  created_at: string;
  project_tasks: { status: string }[];
}

export default async function PanelCliente() {
  await requireUser();

  // Se lee con la sesión del usuario, no con la clave de servicio: si esta consulta no
  // devuelve un proyecto es porque las políticas de la base no dejan verlo, no porque el
  // código se haya acordado de filtrar por propietario.
  const supabase = await getSupabaseServer();
  const { data, error } = await supabase
    .from('projects')
    .select('id, title, objective, status, budget_total, currency, created_at, project_tasks(status)')
    .order('created_at', { ascending: false });

  const proyectos = (data ?? []) as unknown as FilaProyecto[];

  return (
    <div className="space-y-7">
      <div className="entra flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1.5">
          <h1 className="text-2xl font-semibold">Mis proyectos</h1>
          <p className="text-sm text-[var(--color-apagado)]">
            Decís qué querés conseguir. El resto ocurre solo.
          </p>
        </div>
        <EnlaceBoton href="/proyectos/nuevo" variante="primario">
          Nuevo proyecto
        </EnlaceBoton>
      </div>

      {error !== null && (
        <p
          role="alert"
          className="rounded-xl border px-3.5 py-2.5 text-sm"
          style={{
            borderColor: 'color-mix(in oklch, var(--color-fallida) 40%, transparent)',
            backgroundColor: 'color-mix(in oklch, var(--color-fallida) 12%, transparent)',
            color: 'var(--color-fallida)',
          }}
        >
          No se pudieron leer los proyectos: {error.message}
        </p>
      )}

      {proyectos.length === 0 && error === null && (
        <div className="entra" style={{ animationDelay: '80ms' }}>
          <Vacio
            accion={
              <EnlaceBoton href="/proyectos/nuevo" variante="primario">
                Crear el primero
              </EnlaceBoton>
            }
          >
            Todavía no tenés ningún proyecto. Escribí en una frase qué necesitás y mirá cómo
            se arma el grafo de tareas.
          </Vacio>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        {proyectos.map((proyecto, indice) => {
          const tareas = proyecto.project_tasks ?? [];
          const aprobadas = tareas.filter((tarea) => tarea.status === 'approved').length;
          const avance = tareas.length === 0 ? 0 : Math.round((aprobadas / tareas.length) * 100);

          return (
            <Link
              key={proyecto.id}
              href={`/proyectos/${proyecto.id}`}
              className="tarjeta tarjeta-viva entra block p-5"
              style={{ animationDelay: `${60 + indice * 55}ms` }}
            >
              <div className="flex items-start justify-between gap-3">
                <h2 className="text-[0.95rem] leading-snug font-medium text-balance">
                  {proyecto.title}
                </h2>
                <span className="shrink-0 rounded-full bg-[var(--color-lienzo-alto)] px-2.5 py-1 text-[0.7rem] text-[var(--color-apagado)]">
                  {presentarProyecto(proyecto.status)}
                </span>
              </div>

              <p className="mt-2.5 line-clamp-2 text-[0.8rem] leading-relaxed text-[var(--color-apagado)]">
                {proyecto.objective}
              </p>

              <div className="mt-5 space-y-2.5">
                <Avance porcentaje={avance} etiqueta="Tareas aprobadas" />
                <div className="flex items-center justify-between text-xs text-[var(--color-apagado)]">
                  <span>
                    {tareas.length === 0
                      ? 'sin tareas todavía'
                      : `${aprobadas} de ${tareas.length} aprobadas`}
                  </span>
                  <Dinero
                    valor={toNumber(proyecto.budget_total)}
                    moneda={proyecto.currency ?? 'USD'}
                  />
                </div>
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
