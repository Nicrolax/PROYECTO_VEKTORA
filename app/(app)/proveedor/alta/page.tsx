import Link from 'next/link';
import { requireUser } from '@/lib/auth/session';
import { getSupabaseServer } from '@/lib/supabase/server';
import { toNumber, type PgNumeric } from '@/lib/supabase/types';
import { Panel } from '@/components/ui/primitivas';
import { FormularioProveedor } from './formulario';

export const metadata = { title: 'Mi perfil de proveedor · VEKTORA' };

/** La vectorización del perfil llama al modelo de embeddings; 10 s se quedan cortos. */
export const maxDuration = 60;

export default async function AltaProveedor() {
  const user = await requireUser();
  const supabase = await getSupabaseServer();

  const { data } = await supabase
    .from('provider_profiles')
    .select(
      'id, headline, summary, hourly_rate_usd, min_task_budget_usd, availability_hours_week, accepts_auto_assign',
    )
    .eq('user_id', user.id)
    .maybeSingle();

  const perfil = data as unknown as {
    id: string;
    headline: string | null;
    summary: string | null;
    hourly_rate_usd: PgNumeric | null;
    min_task_budget_usd: PgNumeric | null;
    availability_hours_week: number | null;
    accepts_auto_assign: boolean;
  } | null;

  let habilidades: { slug: string; level: number; years: number | null }[] = [];
  if (perfil !== null) {
    const { data: filas } = await supabase
      .from('provider_skills')
      .select('level, years_experience, skills!inner(slug)')
      .eq('provider_profile_id', perfil.id);

    habilidades = ((filas ?? []) as unknown as Array<{
      level: number;
      years_experience: PgNumeric | null;
      skills: { slug: string } | { slug: string }[];
    }>).map((fila) => ({
      slug: Array.isArray(fila.skills) ? (fila.skills[0]?.slug ?? '') : fila.skills.slug,
      level: fila.level,
      years: toNumber(fila.years_experience),
    }));
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <header className="space-y-2">
        <Link
          href="/proveedor"
          className="text-xs text-[var(--color-apagado)] transition-colors hover:text-[var(--color-tenue)]"
        >
          ← Mi trabajo
        </Link>
        <h1 className="text-xl font-semibold tracking-tight">
          {perfil === null ? 'Ofrecerme como proveedor' : 'Mi perfil de proveedor'}
        </h1>
        <p className="text-sm leading-relaxed text-[var(--color-apagado)]">
          El sistema compara tu perfil con cada tarea para decidir a quién adjudicarla. No hay
          postulaciones: si encajás, te llega.
        </p>
      </header>

      <Panel className="p-5">
        <FormularioProveedor
          inicial={
            perfil === null
              ? null
              : {
                  headline: perfil.headline ?? '',
                  summary: perfil.summary ?? '',
                  hourlyRateUsd: toNumber(perfil.hourly_rate_usd),
                  minTaskBudgetUsd: toNumber(perfil.min_task_budget_usd),
                  availabilityHoursWeek: perfil.availability_hours_week,
                  acceptsAutoAssign: perfil.accepts_auto_assign,
                  skills: habilidades,
                }
          }
        />
      </Panel>
    </div>
  );
}
