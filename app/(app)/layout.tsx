import Link from 'next/link';
import { requireUser } from '@/lib/auth/session';
import { cerrarSesion } from '@/app/entrar/acciones';
import { Fondo, Logotipo } from '@/components/ui/marca';
import { Navegacion } from '@/components/ui/navegacion';

/**
 * Envoltorio de todo lo que exige sesión. `requireUser()` corre en el servidor antes de
 * renderizar nada: una página protegida nunca llega a existir para quien no inició sesión.
 */
export default async function LayoutAplicacion({ children }: { children: React.ReactNode }) {
  const user = await requireUser();

  return (
    <div className="min-h-dvh">
      <Fondo />

      <header className="sticky top-0 z-30 border-b border-[var(--color-borde)]/70 bg-[var(--color-lienzo)]/70 backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl items-center gap-4 px-5 py-3">
          <Link href="/panel" className="transition-opacity hover:opacity-80">
            <Logotipo />
          </Link>

          <Navegacion />

          <div className="ml-auto flex items-center gap-2">
            <span className="hidden max-w-[14rem] truncate text-xs text-[var(--color-apagado)] sm:inline">
              {user.email ?? user.id}
            </span>
            <form action={cerrarSesion}>
              <button type="submit" className="boton boton-suave !px-3 !py-1.5 text-xs">
                Salir
              </button>
            </form>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-5 py-9">{children}</main>
    </div>
  );
}
