import { requireUser } from '@/lib/auth/session';
import { Panel } from '@/components/ui/primitivas';
import { FormularioProyecto } from './formulario';

export const metadata = { title: 'Nuevo proyecto · VEKTORA' };

/**
 * La planificación es sincrónica y llama a un modelo de lenguaje: en el free tier de Vercel
 * el límite por defecto son 10 segundos, y una planificación real ronda los 25. Sin esto, la
 * función se cortaría a mitad y el usuario vería un error genérico con el proyecto ya creado.
 */
export const maxDuration = 60;

export default async function NuevoProyecto() {
  await requireUser();

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold tracking-tight">Nuevo proyecto</h1>
        <p className="text-sm text-[var(--color-apagado)]">
          Solo hacen falta dos cosas. El resto lo decide el sistema.
        </p>
      </header>

      <Panel className="p-5">
        <FormularioProyecto />
      </Panel>

      <Panel className="p-5">
        <h2 className="text-sm font-semibold">Qué va a pasar al enviar</h2>
        <ol className="mt-3 space-y-2.5 text-sm text-[var(--color-tenue)]">
          {[
            'Se descompone el objetivo en tareas con criterios de aceptación verificables.',
            'Se comprueba que el grafo de dependencias no tenga ciclos y se repara si hace falta.',
            'Se reparte el presupuesto en proporción al esfuerzo de cada tarea.',
            'Las tareas sin dependencias quedan listas para adjudicarse; el resto, bloqueadas.',
            'El emparejador busca proveedor para cada tarea lista, sin que nadie lo pida.',
          ].map((paso, indice) => (
            <li key={paso} className="flex gap-3">
              <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-[var(--color-borde)] font-mono text-[10px] text-[var(--color-apagado)]">
                {indice + 1}
              </span>
              <span className="leading-relaxed">{paso}</span>
            </li>
          ))}
        </ol>
      </Panel>
    </div>
  );
}
