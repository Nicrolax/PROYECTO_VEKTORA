import { redirect } from 'next/navigation';
import { getSessionUser } from '@/lib/auth/session';
import { Fondo, Logotipo } from '@/components/ui/marca';
import { FormularioAcceso } from './formulario';

export const metadata = { title: 'Entrar' };

const PASOS = [
  { titulo: 'Describís el resultado', texto: 'Una frase y un presupuesto. Nada más.' },
  { titulo: 'Se reparte en tareas', texto: 'Con dependencias y criterios de aceptación.' },
  { titulo: 'Se adjudica sola', texto: 'A quien mejor encaja, con la explicación a la vista.' },
  { titulo: 'Se verifica sola', texto: 'Criterio por criterio, citando la evidencia.' },
];

export default async function Entrar({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; aviso?: string }>;
}) {
  if ((await getSessionUser()) !== null) redirect('/panel');
  const params = await searchParams;

  return (
    <>
      <Fondo intensidad="fuerte" />

      <main className="mx-auto grid min-h-dvh max-w-6xl items-center gap-12 px-5 py-14 lg:grid-cols-[1.05fr_26rem] lg:gap-20 lg:py-20">
        {/* ---- Presentación ---- */}
        <section className="entra space-y-9">
          <Logotipo tamano={24} />

          <div className="space-y-5">
            <h1 className="text-4xl leading-[1.05] font-semibold text-balance sm:text-5xl lg:text-6xl">
              Proyectos que
              <br />
              <span className="texto-marca">se coordinan solos</span>
            </h1>
            <p className="max-w-md text-[0.95rem] leading-relaxed text-[var(--color-tenue)] text-pretty">
              Decís qué necesitás conseguir. El sistema lo descompone, busca quién lo haga,
              revisa lo entregado y sigue adelante. Sin reuniones, sin aprobaciones, sin
              esperar a nadie.
            </p>
          </div>

          <ol className="grid gap-x-8 gap-y-5 sm:grid-cols-2">
            {PASOS.map((paso, indice) => (
              <li
                key={paso.titulo}
                className="entra flex gap-3.5"
                style={{ animationDelay: `${120 + indice * 70}ms` }}
              >
                <span
                  aria-hidden
                  className="degradado-marca mt-1 h-7 w-[3px] shrink-0 rounded-full"
                  style={{ opacity: 1 - indice * 0.16 }}
                />
                <div className="space-y-0.5">
                  <p className="text-sm font-medium">{paso.titulo}</p>
                  <p className="text-[0.8rem] leading-relaxed text-[var(--color-apagado)]">
                    {paso.texto}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        {/* ---- Acceso ---- */}
        <section
          className="entra tarjeta w-full p-6 sm:p-7"
          style={{ animationDelay: '160ms', backdropFilter: 'blur(12px)' }}
        >
          <div className="mb-6 space-y-1.5">
            <h2 className="text-lg font-semibold">Entrá o creá tu cuenta</h2>
            <p className="text-[0.8rem] leading-relaxed text-[var(--color-apagado)]">
              Si es tu primera vez, completá los datos y tocá <strong>Crear cuenta</strong>.
            </p>
          </div>

          {params.error !== undefined && (
            <p
              role="alert"
              className="aparece mb-5 rounded-xl border px-3.5 py-2.5 text-sm leading-relaxed"
              style={{
                borderColor: 'color-mix(in oklch, var(--color-fallida) 40%, transparent)',
                backgroundColor: 'color-mix(in oklch, var(--color-fallida) 12%, transparent)',
                color: 'var(--color-fallida)',
              }}
            >
              {params.error}
            </p>
          )}
          {params.aviso !== undefined && (
            <p
              role="status"
              className="aparece mb-5 rounded-xl border px-3.5 py-2.5 text-sm leading-relaxed"
              style={{
                borderColor: 'color-mix(in oklch, var(--color-aprobada) 40%, transparent)',
                backgroundColor: 'color-mix(in oklch, var(--color-aprobada) 12%, transparent)',
                color: 'var(--color-aprobada)',
              }}
            >
              {params.aviso}
            </p>
          )}

          <FormularioAcceso />
        </section>
      </main>
    </>
  );
}
