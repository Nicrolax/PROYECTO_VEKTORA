/**
 * VEKTORA · FASE 6 — Guardián de sesión.
 *
 * Toda acción de servidor y toda página protegida pasa por aquí antes de operar. No es una
 * formalidad: las acciones de servidor son puntos de entrada HTTP como cualquier otro, y
 * algunas invocan a los agentes autónomos, que usan la clave con privilegios plenos. Sin
 * esta comprobación, cualquiera con la URL podría planificar proyectos ajenos.
 *
 * La autorización FINA —quién puede ver qué proyecto— no vive aquí sino en las políticas de
 * acceso por fila de la base. Aquí solo se resuelve la pregunta anterior: quién eres.
 */

import { redirect } from 'next/navigation';
import { getSupabaseServer } from '@/lib/supabase/server';

export class AuthError extends Error {
  constructor(message: string) {
    super(`VEKTORA/AUTH: ${message}`);
    this.name = 'AuthError';
  }
}

export interface SessionUser {
  id: string;
  email: string | null;
}

/** Usuario de la sesión, o `null` si no hay ninguna. No redirige. */
export async function getSessionUser(): Promise<SessionUser | null> {
  const supabase = await getSupabaseServer();
  // `getUser()` y no `getSession()`: el primero valida el token contra el servidor de
  // autenticación. El segundo se fía de la cookie, que el navegador puede manipular.
  const { data, error } = await supabase.auth.getUser();
  if (error !== null || data.user === null) return null;
  return { id: data.user.id, email: data.user.email ?? null };
}

/** Usuario de la sesión. Si no hay, lleva a la pantalla de acceso. Para páginas. */
export async function requireUser(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (user === null) redirect('/entrar');
  return user;
}

/**
 * Usuario de la sesión. Si no hay, LANZA en vez de redirigir.
 *
 * Es la variante para acciones de servidor: una redirección dentro de una acción se traga
 * el error y el usuario ve un formulario que no hizo nada.
 */
export async function requireUserOrThrow(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (user === null) {
    throw new AuthError('hay que iniciar sesión para realizar esta acción');
  }
  return user;
}
