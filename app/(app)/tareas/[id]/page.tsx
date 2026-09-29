import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireUser } from '@/lib/auth/session';
import { getSupabaseServer } from '@/lib/supabase/server';
import { toNumber, type PgNumeric } from '@/lib/supabase/types';
import { Dato, Dinero, EnlaceBoton, Insignia, Panel, Titulo, Vacio } from '@/components/ui/primitivas';

interface Criterio {
  id: string;
  criterion: string;
  verification?: string;
}

interface Candidatura {
  id: string;
  provider_id: string;
  status: string;
  match_score: PgNumeric | null;
  vector_score: PgNumeric | null;
  skill_score: PgNumeric | null;
  reputation_score: PgNumeric | null;
  match_explanation: { summary?: string } | null;
}

interface Entregable {
  id: string;
  version: number;
  summary: string | null;
  qa_status: string;
  qa_score: PgNumeric | null;
  qa_feedback: { summary?: string; blockingIssues?: string[] } | null;
  qa_criteria_results: Array<{
    id: string;
    outcome: string;
    reported: string;
    confidence: number;
    evidence: string;
    reasoning: string;
    downgraded: boolean;
  }> | null;
  submitted_at: string;
  qa_evaluated_at: string | null;
}

const ICONO: Record<string, string> = { pass: '✓', fail: '✗', unverifiable: '?' };
const COLOR: Record<string, string> = {
  pass: 'var(--color-aprobada)',
  fail: 'var(--color-fallida)',
  unverifiable: 'var(--color-revision)',
};

export default async function DetalleTarea({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const supabase = await getSupabaseServer();

  const { data, error } = await supabase
    .from('project_tasks')
    .select(
      'id, project_id, code, title, description, acceptance_criteria, required_skills, status, budget, estimated_hours, assignee_id, projects!inner(title)',
    )
    .eq('id', id)
    .maybeSingle();

  if (error !== null || data === null) notFound();

  const tarea = data as unknown as {
    project_id: string;
    code: string;
    title: string;
    description: string | null;
    acceptance_criteria: Criterio[];
    required_skills: string[];
    status: string;
    budget: PgNumeric | null;
    estimated_hours: PgNumeric | null;
    assignee_id: string | null;
    projects: { title: string } | { title: string }[];
  };
  const proyecto = Array.isArray(tarea.projects) ? tarea.projects[0] : tarea.projects;

  const [candidaturas, entregables] = await Promise.all([
    supabase
      .from('task_applications')
      .select(
        'id, provider_id, status, match_score, vector_score, skill_score, reputation_score, match_explanation',
      )
      .eq('task_id', id)
      .order('match_score', { ascending: false, nullsFirst: false }),
    supabase
      .from('deliverables')
      .select(
        'id, version, summary, qa_status, qa_score, qa_feedback, qa_criteria_results, submitted_at, qa_evaluated_at',
      )
      .eq('task_id', id)
      .order('version', { ascending: false }),
  ]);

  const listaCandidaturas = (candidaturas.data ?? []) as unknown as Candidatura[];
  const listaEntregables = (entregables.data ?? []) as unknown as Entregable[];
  const criterios = Array.isArray(tarea.acceptance_criteria) ? tarea.acceptance_criteria : [];
  const soyProveedor = tarea.assignee_id === user.id;

  return (
    <div className="space-y-6">
      <header className="space-y-3">
        <Link
          href={`/proyectos/${tarea.project_id}`}
          className="text-xs text-[var(--color-apagado)] transition-colors hover:text-[var(--color-tenue)]"
        >
          ← {proyecto?.title ?? 'Proyecto'}
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-2">
            <p className="font-mono text-xs text-[var(--color-apagado)]">{tarea.code}</p>
            <h1 className="text-xl font-semibold tracking-tight text-balance">{tarea.title}</h1>
            <Insignia estado={tarea.status} />
          </div>
          {soyProveedor && (
            <EnlaceBoton href={`/trabajo/${id}`} variante="primario">
              Entregar trabajo
            </EnlaceBoton>
          )}
        </div>
        {tarea.description !== null && (
          <p className="max-w-3xl text-sm leading-relaxed text-[var(--color-tenue)]">
            {tarea.description}
          </p>
        )}
      </header>

      <Panel className="p-4">
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Dato etiqueta="Presupuesto" valor={<Dinero valor={toNumber(tarea.budget)} />} />
          <Dato
            etiqueta="Esfuerzo estimado"
            valor={`${toNumber(tarea.estimated_hours) ?? '—'} h`}
          />
          <Dato etiqueta="Criterios" valor={String(criterios.length)} />
          <Dato
            etiqueta="Habilidades"
            valor={
              <span className="font-mono text-xs">{(tarea.required_skills ?? []).join(', ')}</span>
            }
          />
        </dl>
      </Panel>

      <Panel className="p-4">
        <Titulo ayuda="Escritos al planificar, antes de que nadie trabaje. Son el contrato que el evaluador comprueba.">
          Criterios de aceptación
        </Titulo>
        <ul className="mt-4 space-y-3">
          {criterios.map((criterio) => (
            <li key={criterio.id} className="flex gap-3">
              <span className="mt-0.5 shrink-0 font-mono text-[11px] text-[var(--color-apagado)]">
                {criterio.id}
              </span>
              <div className="space-y-1">
                <p className="text-sm leading-relaxed">{criterio.criterion}</p>
                {criterio.verification !== undefined && (
                  <p className="text-xs leading-relaxed text-[var(--color-apagado)]">
                    Se comprueba: {criterio.verification}
                  </p>
                )}
              </div>
            </li>
          ))}
          {criterios.length === 0 && <Vacio>Esta tarea no tiene criterios registrados.</Vacio>}
        </ul>
      </Panel>

      <Panel className="p-4">
        <Titulo ayuda="Puntuación de cada candidato con su desglose. Ninguna adjudicación ocurre sin esta explicación.">
          Candidaturas
        </Titulo>
        <div className="mt-4 space-y-3">
          {listaCandidaturas.length === 0 && (
            <Vacio>Todavía no se puntuó ningún candidato para esta tarea.</Vacio>
          )}
          {listaCandidaturas.map((candidatura) => (
            <div
              key={candidatura.id}
              className="rounded-lg border border-[var(--color-borde)] bg-[var(--color-panel-alto)] p-3"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-medium tabular-nums">
                  {(toNumber(candidatura.match_score) ?? 0).toFixed(4)}
                </span>
                <span className="text-xs text-[var(--color-apagado)]">{candidatura.status}</span>
              </div>
              <dl className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-[var(--color-tenue)]">
                <span>afinidad {(toNumber(candidatura.vector_score) ?? 0).toFixed(3)}</span>
                <span>habilidades {(toNumber(candidatura.skill_score) ?? 0).toFixed(3)}</span>
                <span>reputación {(toNumber(candidatura.reputation_score) ?? 0).toFixed(3)}</span>
              </dl>
              {candidatura.match_explanation?.summary !== undefined && (
                <p className="mt-2 text-xs leading-relaxed text-[var(--color-apagado)]">
                  {candidatura.match_explanation.summary}
                </p>
              )}
            </div>
          ))}
        </div>
      </Panel>

      <Panel className="p-4">
        <Titulo ayuda="Cada entrega con el veredicto del evaluador, criterio por criterio y con la evidencia citada.">
          Entregas y veredictos
        </Titulo>
        <div className="mt-4 space-y-4">
          {listaEntregables.length === 0 && <Vacio>Todavía no hay ninguna entrega.</Vacio>}
          {listaEntregables.map((entregable) => (
            <article
              key={entregable.id}
              className="rounded-lg border border-[var(--color-borde)] bg-[var(--color-panel-alto)] p-4"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2.5">
                  <span className="font-mono text-xs text-[var(--color-apagado)]">
                    v{entregable.version}
                  </span>
                  <Insignia estado={entregable.qa_status} tipo="qa" />
                </div>
                {entregable.qa_score !== null && (
                  <span className="text-sm tabular-nums">
                    {(toNumber(entregable.qa_score) ?? 0).toFixed(2)} / 100
                  </span>
                )}
              </div>

              {entregable.summary !== null && (
                <p className="mt-2.5 text-sm leading-relaxed">{entregable.summary}</p>
              )}

              {entregable.qa_feedback?.summary !== undefined && (
                <p className="mt-3 rounded-md border-l-2 border-[var(--color-acento)] bg-[var(--color-panel)] px-3 py-2 text-xs leading-relaxed text-[var(--color-tenue)]">
                  {entregable.qa_feedback.summary}
                </p>
              )}

              {(entregable.qa_criteria_results ?? []).length > 0 && (
                <ul className="mt-3 space-y-2.5 border-t border-[var(--color-borde)] pt-3">
                  {(entregable.qa_criteria_results ?? []).map((resultado) => (
                    <li key={resultado.id} className="flex gap-2.5">
                      <span
                        aria-hidden
                        className="mt-px shrink-0 font-mono text-sm"
                        style={{ color: COLOR[resultado.outcome] ?? 'var(--color-apagado)' }}
                      >
                        {ICONO[resultado.outcome] ?? '·'}
                      </span>
                      <div className="space-y-1">
                        <p className="text-xs">
                          <span className="font-mono text-[var(--color-apagado)]">
                            {resultado.id}
                          </span>{' '}
                          <span style={{ color: COLOR[resultado.outcome] }}>
                            {resultado.outcome}
                          </span>
                          {resultado.downgraded && (
                            <span className="text-[var(--color-apagado)]">
                              {' '}
                              — el modelo dijo {resultado.reported}, degradado por confianza{' '}
                              {resultado.confidence.toFixed(2)}
                            </span>
                          )}
                        </p>
                        <p className="text-xs leading-relaxed text-[var(--color-tenue)]">
                          {resultado.reasoning}
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </article>
          ))}
        </div>
      </Panel>
    </div>
  );
}
