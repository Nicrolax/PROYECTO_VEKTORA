/**
 * VEKTORA · FASE 6 — Refresco de sesión.
 *
 * El archivo se llama `proxy.ts` porque Next 16 sustituyó el convenio `middleware`. Es el
 * mismo mecanismo: código que corre antes de cada petición.
 *
 * Los tokens de Supabase caducan. Este middleware los renueva en cada petición y reescribe
 * las cookies, porque un Server Component no puede escribirlas: si el refresco no ocurriera
 * aquí, la sesión moriría en silencio y el usuario acabaría en la pantalla de acceso a
 * mitad de una tarea sin saber por qué.
 *
 * NO decide permisos. De eso se encargan `requireUser()` y las políticas de la base.
 */

import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

export default async function proxy(request: NextRequest): Promise<NextResponse> {
  let response = NextResponse.next({ request });

  const url = process.env['NEXT_PUBLIC_SUPABASE_URL'];
  const anonKey = process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY'];
  // Sin configuración no hay nada que refrescar; las páginas ya avisan del problema.
  if (url === undefined || url === '' || anonKey === undefined || anonKey === '') {
    return response;
  }

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(toSet) {
        for (const { name, value } of toSet) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of toSet) response.cookies.set(name, value, options);
      },
    },
  });

  await supabase.auth.getUser();
  return response;
}

export const config = {
  matcher: [
    // Todo menos estáticos, imágenes y el disparador de trabajos programados, que se
    // autentica con su propio secreto y no tiene sesión de usuario que refrescar.
    '/((?!_next/static|_next/image|favicon.ico|api/cron|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
