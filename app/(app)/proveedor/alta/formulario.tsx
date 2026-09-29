'use client';

import { useActionState, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { registrarProveedor, type ResultadoAlta } from '@/app/acciones/proveedor';

const INICIAL: ResultadoAlta = { ok: false, error: null, resoluciones: [] };

const ORIGEN: Record<string, { etiqueta: string; explicacion: string; color: string }> = {
  exact: {
    etiqueta: 'exacta',
    explicacion: 'Coincidía tal cual con una habilidad del catálogo.',
    color: 'var(--color-aprobada)',
  },
  alias: {
    etiqueta: 'sinónimo conocido',
    explicacion: 'Ya se había mapeado antes; no hizo falta recalcular nada.',
    color: 'var(--color-lista)',
  },
  semantic: {
    etiqueta: 'por significado',
    explicacion: 'Se comparó tu texto con el catálogo y se mapeó a la más parecida.',
    color: 'var(--color-emparejando)',
  },
  created: {
    etiqueta: 'nueva en el catálogo',
    explicacion: 'No se parecía a ninguna existente, así que el catálogo creció.',
    color: 'var(--color-revision)',
  },
};

function Enviar() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="boton boton-primario degradado-marca w-full sm:w-auto"
    >
      {pending ? 'Registrando…' : 'Guardar perfil'}
    </button>
  );
}

const CAMPO = 'campo';

export function FormularioProveedor({
  inicial,
}: {
  inicial: {
    headline: string;
    summary: string;
    hourlyRateUsd: number | null;
    minTaskBudgetUsd: number | null;
    availabilityHoursWeek: number | null;
    acceptsAutoAssign: boolean;
    skills: { slug: string; level: number; years: number | null }[];
  } | null;
}) {
  const [estado, accion] = useActionState(registrarProveedor, INICIAL);
  const [filas, setFilas] = useState(
    inicial?.skills.length ? inicial.skills : [{ slug: '', level: 3, years: null }],
  );

  return (
    <form action={accion} className="space-y-6">
      <div className="space-y-1.5">
        <label htmlFor="headline" className="block text-sm font-medium">
          ¿Qué hacés? En una línea
        </label>
        <input
          id="headline"
          name="headline"
          required
          minLength={10}
          maxLength={160}
          defaultValue={inicial?.headline ?? ''}
          placeholder="Ej.: Diseñadora de producto: investigación UX, wireframes e interfaz visual"
          className={CAMPO}
        />
        <p className="text-xs text-[var(--color-apagado)]">
          Es la señal más fuerte para el emparejamiento semántico. Concreto gana a genérico.
        </p>
      </div>

      <div className="space-y-1.5">
        <label htmlFor="summary" className="block text-sm font-medium">
          Tu experiencia
        </label>
        <textarea
          id="summary"
          name="summary"
          required
          minLength={40}
          rows={5}
          defaultValue={inicial?.summary ?? ''}
          placeholder="Qué tipo de proyectos hiciste, con qué herramientas y con qué alcance."
          className={`${CAMPO} resize-y leading-relaxed`}
        />
      </div>

      <fieldset className="space-y-3">
        <legend className="text-sm font-medium">Habilidades</legend>
        <p className="text-xs leading-relaxed text-[var(--color-apagado)]">
          Escribilas como quieras. El sistema las normaliza contra el catálogo y te muestra a
          qué se resolvió cada una.
        </p>

        {filas.map((fila, indice) => (
          <div key={indice} className="flex flex-wrap gap-2">
            <input
              name="skill_slug"
              defaultValue={fila.slug}
              placeholder="Ej.: investigación UX"
              className={`${CAMPO} flex-1 min-w-48`}
              aria-label={`Habilidad ${indice + 1}`}
            />
            <select
              name="skill_level"
              defaultValue={String(fila.level)}
              aria-label={`Nivel de la habilidad ${indice + 1}`}
              className={`${CAMPO} w-32`}
            >
              {[1, 2, 3, 4, 5].map((nivel) => (
                <option key={nivel} value={nivel}>
                  Nivel {nivel}
                </option>
              ))}
            </select>
            <input
              name="skill_years"
              type="number"
              min={0}
              max={60}
              defaultValue={fila.years ?? ''}
              placeholder="años"
              aria-label={`Años de experiencia en la habilidad ${indice + 1}`}
              className={`${CAMPO} w-24`}
            />
            {filas.length > 1 && (
              <button
                type="button"
                onClick={() => setFilas((f) => f.filter((_, i) => i !== indice))}
                aria-label={`Quitar habilidad ${indice + 1}`}
                className="rounded-lg border border-[var(--color-borde)] px-3 text-sm text-[var(--color-apagado)] transition-colors hover:text-[var(--color-fallida)]"
              >
                ×
              </button>
            )}
          </div>
        ))}

        <button
          type="button"
          onClick={() => setFilas((f) => [...f, { slug: '', level: 3, years: null }])}
          className="rounded-xl border border-dashed border-[var(--color-borde)] px-3.5 py-2 text-xs text-[var(--color-tenue)] transition-colors hover:border-[var(--color-borde-vivo)] hover:bg-[var(--color-panel)]"
        >
          + Añadir habilidad
        </button>
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="space-y-1.5">
          <label htmlFor="hourlyRateUsd" className="block text-sm font-medium">
            Tarifa por hora
          </label>
          <input
            id="hourlyRateUsd"
            name="hourlyRateUsd"
            type="number"
            min={0}
            defaultValue={inicial?.hourlyRateUsd ?? ''}
            className={CAMPO}
          />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="minTaskBudgetUsd" className="block text-sm font-medium">
            Mínimo por tarea
          </label>
          <input
            id="minTaskBudgetUsd"
            name="minTaskBudgetUsd"
            type="number"
            min={0}
            defaultValue={inicial?.minTaskBudgetUsd ?? ''}
            className={CAMPO}
          />
          <p className="text-xs text-[var(--color-apagado)]">
            No se te ofrecerán tareas que paguen menos.
          </p>
        </div>
        <div className="space-y-1.5">
          <label htmlFor="availabilityHoursWeek" className="block text-sm font-medium">
            Horas por semana
          </label>
          <input
            id="availabilityHoursWeek"
            name="availabilityHoursWeek"
            type="number"
            min={0}
            max={168}
            defaultValue={inicial?.availabilityHoursWeek ?? ''}
            className={CAMPO}
          />
        </div>
      </div>

      <label className="flex gap-3 rounded-lg border border-[var(--color-borde)] bg-[var(--color-panel)] p-3.5">
        <input
          type="checkbox"
          name="acceptsAutoAssign"
          value="si"
          defaultChecked={inicial?.acceptsAutoAssign ?? true}
          className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--color-acento)]"
        />
        <span className="space-y-1">
          <span className="block text-sm font-medium">Acepto adjudicación automática</span>
          <span className="block text-xs leading-relaxed text-[var(--color-apagado)]">
            Sin esto no recibirás tareas: el sistema no adjudica trabajo a quien no lo pidió.
            Podés cambiarlo cuando quieras.
          </span>
        </span>
      </label>

      {estado.error !== null && (
        <p
          role="alert"
          className="rounded-lg border border-[var(--color-fallida)]/40 bg-[var(--color-fallida)]/10 px-3 py-2 text-sm leading-relaxed text-[var(--color-fallida)]"
        >
          {estado.error}
        </p>
      )}

      {estado.ok && (
        <div
          role="status"
          className="space-y-3 rounded-lg border border-[var(--color-aprobada)]/40 bg-[var(--color-aprobada)]/10 p-4"
        >
          <p className="text-sm font-medium text-[var(--color-aprobada)]">
            Perfil guardado. Así se resolvieron tus habilidades:
          </p>
          <ul className="space-y-1.5">
            {estado.resoluciones.map((resolucion) => {
              const origen = ORIGEN[resolucion.origen];
              return (
                <li
                  key={`${resolucion.escrito}-${resolucion.resuelto}`}
                  className="flex flex-wrap items-baseline gap-x-2 text-xs"
                  title={origen?.explicacion}
                >
                  <span className="text-[var(--color-apagado)]">{resolucion.escrito}</span>
                  <span aria-hidden className="text-[var(--color-apagado)]">
                    →
                  </span>
                  <span className="font-mono">{resolucion.resuelto}</span>
                  <span style={{ color: origen?.color ?? 'var(--color-apagado)' }}>
                    {origen?.etiqueta ?? resolucion.origen}
                    {resolucion.similitud !== null && ` (${resolucion.similitud.toFixed(3)})`}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <Enviar />
    </form>
  );
}
