import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireUser } from '@/lib/auth/session';
import { getSupabaseServer } from '@/lib/supabase/server';
import { toNumber, type PgNumeric } from '@/lib/supabase/types';
import { Dato, Panel, Titulo, Vacio } from '@/components/ui/primitivas';

export const metadata = { title: 'Consumo de IA' };

interface FilaCorrida {
  id: string;
  operation: string;
  provider: string;
  model: string;
  status: string;
  attempt: number;
  fell_back_from: string | null;
  total_tokens: number | null;
  cost_usd: PgNumeric | null;
  latency_ms: number | null;
  error_message: string | null;
  created_at: string;
}

const OPERACION: Record<string, string> = {
  project_planning: 'planificación',
  task_decomposition: 'descomposición',
  embedding: 'vectorización',
  matching: 'emparejamiento',
  qa_judge: 'evaluación',
  schema_repair: 'reparación de esquema',
  summarization: 'resumen',
  other: 'otra',
};

const ESTADO: Record<string, { etiqueta: string; color: string }> = {
  success: { etiqueta: 'correcta', color: 'var(--color-aprobada)' },
  repaired: { etiqueta: 'reparada', color: 'var(--color-revision)' },
  invalid_output: { etiqueta: 'salida inválida', color: 'var(--color-revision)' },
  rate_limited: { etiqueta: 'cuota agotada', color: 'var(--color-entregada)' },
  timeout: { etiqueta: 'sin respuesta', color: 'var(--color-entregada)' },
  failed: { etiqueta: 'fallida', color: 'var(--color-fallida)' },
  pending: { etiqueta: 'en curso', color: 'var(--color-emparejando)' },
};

/**
 * Observabilidad del consumo de IA (RF-8.6).
 *
 * Cada llamada a un modelo queda registrada en `ai_runs` con su operación, proveedor,
 * estado, tokens y coste. Esta vista lo muestra porque en un sistema que decide solo, la
 * pregunta «¿por qué se gastó esto?» tiene que tener respuesta sin abrir la base de datos.
 *
 * `fell_back_from` es la columna que más información da: si aparece, el proveedor primario
 * falló y el respaldo salvó la operación sin que nadie se enterara.
 */
export default async function ConsumoProyecto({ params }: { params: Promise<{ id: string }> }) {
  await requireUser();
  const { id } = await params;
  const supabase = await getSupabaseServer();

  const proyecto = await supabase
    .from('projects')
    .select('id, title')
    .eq('id', id)
    .maybeSingle();
  if (proyecto.error !== null || proyecto.data === null) notFound();

  const { data } = await supabase
    .from('ai_runs')
    .select(
      'id, operation, provider, model, status, attempt, fell_back_from, total_tokens, cost_usd, latency_ms, error_message, created_at',
    )
    .eq('project_id', id)
    .order('created_at', { ascending: false })
    .limit(100);

  const corridas = (data ?? []) as unknown as FilaCorrida[];

  const tokens = corridas.reduce((suma, fila) => suma + (fila.total_tokens ?? 0), 0);
  const coste = corridas.reduce((suma, fila) => suma + (toNumber(fila.cost_usd) ?? 0), 0);
  const conRespaldo = corridas.filter((fila) => fila.fell_back_from !== null).length;
  const fallidas = corridas.filter((fila) =>
    ['failed', 'timeout', 'rate_limited'].includes(fila.status),
  ).length;

  const titulo = (proyecto.data as unknown as { title: string }).title;

  return (
    <div className="space-y-6">
      <header className="entra space-y-3">
        <Link
          href={`/proyectos/${id}`}
          className="text-xs text-[var(--color-apagado)] transition-colors hover:text-[var(--color-tenue)]"
        >
          ← {titulo}
        </Link>
        <h1 className="text-2xl font-semibold">Consumo de inteligencia artificial</h1>
        <p className="max-w-2xl text-sm leading-relaxed text-[var(--color-apagado)]">
          Cada decisión automática de este proyecto costó una o varias llamadas a un modelo.
          Acá está el detalle de todas.
        </p>
      </header>

      <Panel className="p-5" retraso={60}>
        <dl className="grid grid-cols-2 gap-5 sm:grid-cols-4">
          <Dato etiqueta="Operaciones" valor={String(corridas.length)} />
          <Dato etiqueta="Tokens" valor={tokens.toLocaleString('es-UY')} />
          <Dato
            etiqueta="Coste"
            valor={coste === 0 ? 'free tier' : `USD ${coste.toFixed(6)}`}
          />
          <Dato
            etiqueta="Con respaldo"
            valor={
              conRespaldo === 0 ? (
                'ninguna'
              ) : (
                <span style={{ color: 'var(--color-revision)' }}>{conRespaldo}</span>
              )
            }
          />
        </dl>
        {conRespaldo > 0 && (
          <p className="mt-4 border-t border-[var(--color-borde)] pt-4 text-xs leading-relaxed text-[var(--color-apagado)]">
            En {conRespaldo} {conRespaldo === 1 ? 'operación' : 'operaciones'} el proveedor
            primario falló y el de respaldo la completó. El sistema siguió funcionando sin que
            nadie interviniera: eso es la cadena de fallback haciendo su trabajo.
          </p>
        )}
        {fallidas > 0 && (
          <p className="mt-3 text-xs leading-relaxed" style={{ color: 'var(--color-fallida)' }}>
            {fallidas} {fallidas === 1 ? 'operación falló' : 'operaciones fallaron'} por
            completo. Revisá abajo el motivo.
          </p>
        )}
      </Panel>

      <Panel className="p-5" retraso={120}>
        <Titulo ayuda="De la más reciente a la más antigua. Máximo 100.">Operaciones</Titulo>

        <div className="mt-4 space-y-1">
          {corridas.length === 0 && (
            <Vacio>
              Todavía no hay ninguna llamada registrada para este proyecto.
            </Vacio>
          )}

          {corridas.map((fila) => {
            const estado = ESTADO[fila.status] ?? {
              etiqueta: fila.status,
              color: 'var(--color-apagado)',
            };
            return (
              <div
                key={fila.id}
                className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-[var(--color-borde)] py-2 text-xs last:border-0"
              >
                <span className="w-36 shrink-0 font-medium">
                  {OPERACION[fila.operation] ?? fila.operation}
                </span>
                <span style={{ color: estado.color }}>{estado.etiqueta}</span>
                <span className="font-mono text-[var(--color-apagado)]">
                  {fila.provider}/{fila.model}
                </span>
                {fila.fell_back_from !== null && (
                  <span style={{ color: 'var(--color-revision)' }}>
                    respaldo tras {fila.fell_back_from}
                  </span>
                )}
                {fila.attempt > 1 && (
                  <span className="text-[var(--color-apagado)]">intento {fila.attempt}</span>
                )}
                <span className="ml-auto flex gap-4 text-[var(--color-apagado)] tabular-nums">
                  {fila.total_tokens !== null && <span>{fila.total_tokens} tok</span>}
                  {fila.latency_ms !== null && <span>{fila.latency_ms} ms</span>}
                </span>
                {fila.error_message !== null && (
                  <p
                    className="w-full leading-relaxed"
                    style={{ color: 'var(--color-fallida)' }}
                  >
                    {fila.error_message}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      </Panel>
    </div>
  );
}
