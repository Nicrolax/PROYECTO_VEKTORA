/**
 * VEKTORA · FASE 6 — Cliente Supabase del NAVEGADOR.
 *
 * Usa la clave anónima y la sesión del usuario, así que **todo lo que lea pasa por las
 * políticas de acceso por fila**. Es el único módulo de este dominio que puede importar un
 * componente de cliente: `@/lib/supabase` reexporta el cliente `service_role`, que bypassea
 * esas políticas y no puede acabar en un bundle de navegador.
 *
 * Se usa para una sola cosa: suscribirse a los cambios en vivo del grafo. Las lecturas de
 * datos ocurren en el servidor, donde el renderizado es más rápido y no hay que enviar al
 * navegador más de lo que va a mostrar.
 */

import { createBrowserClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';

let cached: SupabaseClient | null = null;

export class SupabaseBrowserError extends Error {
  constructor(message: string) {
    super(`VEKTORA/DB: ${message}`);
    this.name = 'SupabaseBrowserError';
  }
}

/** Cliente anónimo, memorizado: varias suscripciones comparten una sola conexión. */
export function getSupabaseBrowser(): SupabaseClient {
  if (cached !== null) return cached;

  const url = process.env['NEXT_PUBLIC_SUPABASE_URL'];
  const anonKey = process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY'];

  if (url === undefined || url === '' || anonKey === undefined || anonKey === '') {
    throw new SupabaseBrowserError(
      'faltan NEXT_PUBLIC_SUPABASE_URL y/o NEXT_PUBLIC_SUPABASE_ANON_KEY. ' +
        'Ambas llevan el prefijo NEXT_PUBLIC_ a propósito: son públicas por diseño y la ' +
        'seguridad la dan las políticas de acceso, no el secreto de la clave.',
    );
  }

  cached = createBrowserClient(url, anonKey);
  return cached;
}
