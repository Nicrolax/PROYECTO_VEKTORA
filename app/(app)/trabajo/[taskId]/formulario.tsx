'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { entregarTrabajo, type ResultadoEntrega } from '@/app/acciones/entregas';

const INICIAL: ResultadoEntrega = { ok: false, error: null, faltantes: [] };

interface Criterio {
  id: string;
  criterion: string;
  verification?: string;
}

function Enviar({ confirmando }: { confirmando: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="boton boton-primario degradado-marca w-full sm:w-auto"
    >
      {pending ? 'Enviando…' : confirmando ? 'Entregar igual' : 'Entregar para evaluación'}
    </button>
  );
}

/**
 * Espacio de entrega (RF-5.1, RF-5.2).
 *
 * Los criterios de aceptación están junto al campo de evidencia de cada uno, no en otra
 * pantalla. Es la diferencia entre entregar contra un contrato y entregar a ciegas: el
 * evaluador va a comprobar exactamente esto, así que esconderlo solo produce revisiones.
 */
export function FormularioEntrega({
  taskId,
  criterios,
}: {
  taskId: string;
  criterios: Criterio[];
}) {
  const [estado, accion] = useActionState(entregarTrabajo, INICIAL);
  const confirmando = estado.faltantes.length > 0;

  return (
    <form action={accion} className="space-y-6">
      <input type="hidden" name="taskId" value={taskId} />
      {confirmando && <input type="hidden" name="confirmar" value="si" />}

      <div className="space-y-1.5">
        <label htmlFor="summary" className="block text-sm font-medium">
          Resumen de lo entregado
        </label>
        <textarea
          id="summary"
          name="summary"
          required
          minLength={10}
          rows={2}
          placeholder="Qué entregás, en una o dos frases."
          className="campo resize-y"
        />
      </div>

      <div className="space-y-1.5">
        <label htmlFor="content" className="block text-sm font-medium">
          El trabajo
        </label>
        <textarea
          id="content"
          name="content"
          required
          rows={14}
          placeholder="El contenido entregado, o dónde está y cómo acceder a él."
          className="campo resize-y font-mono !text-xs leading-relaxed"
        />
      </div>

      <fieldset className="space-y-4">
        <legend className="text-sm font-medium">
          Evidencia por criterio
          <span className="ml-2 font-normal text-[var(--color-apagado)]">
            dónde se demuestra cada uno
          </span>
        </legend>

        {criterios.map((criterio) => {
          const falta = estado.faltantes.includes(criterio.id);
          return (
            <div
              key={criterio.id}
              className="space-y-2 rounded-lg border p-3"
              style={{
                borderColor: falta ? 'var(--color-revision)' : 'var(--color-borde)',
                backgroundColor: 'var(--color-panel)',
              }}
            >
              <div className="space-y-1">
                <p className="text-sm leading-relaxed">
                  <span className="mr-2 font-mono text-[11px] text-[var(--color-apagado)]">
                    {criterio.id}
                  </span>
                  {criterio.criterion}
                </p>
                {criterio.verification !== undefined && (
                  <p className="text-xs leading-relaxed text-[var(--color-apagado)]">
                    Se comprueba: {criterio.verification}
                  </p>
                )}
              </div>
              <textarea
                name={`evidencia:${criterio.id}`}
                rows={2}
                aria-label={`Evidencia para ${criterio.id}`}
                placeholder="Ej.: sección 3 del contenido, donde están las seis referencias."
                className="campo resize-y !text-xs"
              />
            </div>
          );
        })}

        {criterios.length === 0 && (
          <p className="rounded-lg border border-dashed border-[var(--color-borde)] px-4 py-5 text-center text-xs text-[var(--color-apagado)]">
            Esta tarea no declara criterios de aceptación, así que el evaluador no podrá
            aprobarla. Avisá al cliente antes de trabajar.
          </p>
        )}
      </fieldset>

      {confirmando && (
        <p
          role="alert"
          className="rounded-lg border border-[var(--color-revision)]/40 bg-[var(--color-revision)]/10 px-3 py-2.5 text-sm leading-relaxed text-[var(--color-revision)]"
        >
          Sin evidencia declarada para {estado.faltantes.join(', ')}. Podés entregar igual: el
          evaluador los juzgará contra el contenido general, con menos confianza. Volvé a
          pulsar para confirmar.
        </p>
      )}

      {estado.error !== null && (
        <p
          role="alert"
          className="rounded-lg border border-[var(--color-fallida)]/40 bg-[var(--color-fallida)]/10 px-3 py-2 text-sm text-[var(--color-fallida)]"
        >
          {estado.error}
        </p>
      )}

      <Enviar confirmando={confirmando} />
    </form>
  );
}
