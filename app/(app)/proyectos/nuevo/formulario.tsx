'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { crearProyecto, type ResultadoCrear } from '@/app/acciones/proyectos';

const INICIAL: ResultadoCrear = { ok: false, error: null };

/**
 * El envío tarda entre 20 y 40 segundos: el planificador llama al modelo, valida el grafo,
 * reparte el presupuesto y vectoriza cada tarea. Por eso el estado de espera no es un
 * detalle estético — sin él, la persona cree que el formulario se colgó y vuelve a pulsar
 * (RF-2.8).
 */
function Enviar() {
  const { pending } = useFormStatus();
  return (
    <div className="space-y-3">
      <button
        type="submit"
        disabled={pending}
        className="boton boton-primario degradado-marca w-full sm:w-auto"
      >
        {pending ? 'Planificando…' : 'Crear y planificar'}
      </button>

      {pending && (
        <div
          role="status"
          className="space-y-2 rounded-lg border border-[var(--color-borde)] bg-[var(--color-panel)] p-4"
        >
          <div className="h-1.5 overflow-hidden rounded-full bg-[var(--color-lienzo-alto)]">
            <div className="degradado-marca h-full w-1/3 animate-[recorrer_1.5s_ease-in-out_infinite] rounded-full" />
          </div>
          <p className="text-xs leading-relaxed text-[var(--color-apagado)]">
            Descomponiendo el objetivo en tareas, comprobando que el grafo no tenga ciclos,
            repartiendo el presupuesto y vectorizando cada tarea. Suele tardar medio minuto.
          </p>
        </div>
      )}

      
    </div>
  );
}

export function FormularioProyecto() {
  const [estado, accion] = useActionState(crearProyecto, INICIAL);

  return (
    <form action={accion} className="space-y-5">
      <div className="space-y-1.5">
        <label htmlFor="objective" className="block text-sm font-medium">
          ¿Qué necesitás conseguir?
        </label>
        <textarea
          id="objective"
          name="objective"
          required
          minLength={20}
          maxLength={2000}
          rows={5}
          placeholder="Ej.: una guía de estilo de marca para una cafetería de especialidad, con paleta, tipografía, uso del logo y mockups de empaque."
          className="campo resize-y leading-relaxed"
        />
        <p className="text-xs text-[var(--color-apagado)]">
          Escribilo como se lo explicarías a alguien. Cuanto más concreto sea el resultado que
          buscás, mejor queda el reparto en tareas.
        </p>
      </div>

      <div className="space-y-1.5">
        <label htmlFor="budgetTotal" className="block text-sm font-medium">
          Presupuesto total (USD)
        </label>
        <input
          id="budgetTotal"
          name="budgetTotal"
          type="number"
          min={1}
          max={1000000}
          step="1"
          required
          defaultValue={800}
          className="campo tabular-nums sm:!w-48"
        />
        <p className="text-xs text-[var(--color-apagado)]">
          Se reparte entre las tareas en proporción al esfuerzo. La suma coincide exactamente
          con este total, al céntimo.
        </p>
      </div>

      {estado.error !== null && (
        <p
          role="alert"
          className="rounded-lg border border-[var(--color-fallida)]/40 bg-[var(--color-fallida)]/10 px-3 py-2 text-sm leading-relaxed text-[var(--color-fallida)]"
        >
          {estado.error}
        </p>
      )}

      <Enviar />
    </form>
  );
}
