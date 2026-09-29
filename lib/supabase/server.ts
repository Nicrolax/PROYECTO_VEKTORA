/**
 * VEKTORA · FASE 6 — Cliente Supabase del SERVIDOR, con la sesión del usuario.
 *
 * Tres clientes distintos conviven en el proyecto y la diferencia importa:
 *
 *   · `admin.ts`    — `service_role`. Bypassea las políticas de acceso. Es la identidad de
 *                     los agentes autónomos. Solo servidor, nunca a petición del navegador
 *                     sin comprobar antes quién pide.
 *   · `server.ts`   — clave anónima MÁS la sesión del usuario, leída de las cookies. Todo lo
 *                     que devuelve ya pasó por las políticas: si una consulta no devuelve
 *                     una fila, es porque ese usuario no puede verla.
 *   · `browser.ts`  — clave anónima en el navegador, para las suscripciones en vivo.
 *
 * Las páginas leen con ESTE cliente. Así la interfaz no puede mostrar por accidente datos
 * ajenos: la frontera de seguridad está en la base, no en que el código se acuerde de
 * filtrar por `owner_id`.
 */

import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';

export class SupabaseServerError extends Error {
  constructor(message: string) {
    super(`VEKTORA/DB: ${message}`);
    this.name = 'SupabaseServerError';
  }
}

function readPublicEnv(): { url: string; anonKey: string } {
  const url = process.env['NEXT_PUBLIC_SUPABASE_URL'];
  const anonKey = process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY'];
  if (url === undefined || url === '' || anonKey === undefined || anonKey === '') {
    throw new SupabaseServerError(
      'faltan NEXT_PUBLIC_SUPABASE_URL y/o NEXT_PUBLIC_SUPABASE_ANON_KEY en el entorno',
    );
  }
  return { url, anonKey };
}

/**
 * Cliente ligado a la sesión de la petición en curso.
 *
 * No se memoriza a propósito: cada petición trae su propia sesión, y reutilizar un cliente
 * entre peticiones mezclaría usuarios.
 */
export async function getSupabaseServer(): Promise<SupabaseClient> {
  // `cookies()` PRIMERO, y no por estilo: es la llamada que marca la página como dinámica.
  // Al revés, la comprobación de entorno se ejecutaba durante el prerenderizado —donde no
  // hay variables de entorno de despliegue— y reventaba la compilación entera.
  const store = await cookies();
  const { url, anonKey } = readPublicEnv();

  return createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return store.getAll();
      },
      setAll(toSet) {
        // En un Server Component las cookies son de solo lectura y esto lanza. No es un
        // error: el middleware ya refrescó la sesión antes de llegar aquí, así que se
        // ignora en lugar de romper el renderizado.
        try {
          for (const { name, value, options } of toSet) store.set(name, value, options);
        } catch {
          /* refrescado por el middleware */
        }
      },
    },
  });
}
