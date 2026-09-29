/**
 * VEKTORA — Cliente Supabase `service_role`.
 *
 * Esta es la identidad de los AGENTES AUTÓNOMOS (ProjectPlanner, matching, AI Judge) y de
 * la telemetría de `ai_runs`. `service_role` BYPASSEA RLS por diseño, así que este módulo
 * jamás puede acabar en un bundle de navegador: el guardia de abajo lanza si se importa en
 * el cliente, en vez de filtrar la clave silenciosamente.
 *
 * Hay un único cliente admin en todo el proyecto. Se instancia de forma perezosa y
 * memorizada: importar este módulo NO exige que las variables existan, y así `next build`
 * y las pruebas unitarias no necesitan credenciales.
 *
 *   import { getSupabaseAdmin } from '@/lib/supabase/admin';
 *   const { data } = await getSupabaseAdmin().from('projects').select('id');
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export interface SupabaseAdminOptions {
  url?: string | undefined;
  serviceRoleKey?: string | undefined;
}

/** Error de configuración del acceso a datos. No lleva ninguna clave en el mensaje. */
export class SupabaseAdminError extends Error {
  constructor(message: string) {
    super(`VEKTORA/DB: ${message}`);
    this.name = 'SupabaseAdminError';
  }
}

function assertServerOnly(): void {
  // `window` definido = estamos en el navegador. La clave service_role no puede llegar ahí.
  if (typeof window !== 'undefined') {
    throw new SupabaseAdminError(
      'lib/supabase/admin solo puede usarse en servidor: expone la clave service_role, ' +
        'que bypassea RLS. En el cliente usa el cliente anónimo con NEXT_PUBLIC_*.',
    );
  }
}

function readEnv(name: string): string | undefined {
  const value = process.env[name];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** Resuelve URL y clave, con los alias de Next.js como respaldo para la URL. */
export function resolveAdminCredentials(options: SupabaseAdminOptions = {}): {
  url: string;
  serviceRoleKey: string;
} {
  const url = options.url ?? readEnv('SUPABASE_URL') ?? readEnv('NEXT_PUBLIC_SUPABASE_URL');
  const serviceRoleKey = options.serviceRoleKey ?? readEnv('SUPABASE_SERVICE_ROLE_KEY');

  if (url === undefined) {
    throw new SupabaseAdminError(
      'falta SUPABASE_URL (o NEXT_PUBLIC_SUPABASE_URL). Cópiala de env.example a .env.local.',
    );
  }
  if (serviceRoleKey === undefined) {
    throw new SupabaseAdminError(
      'falta SUPABASE_SERVICE_ROLE_KEY. Es la clave de los agentes autónomos y NUNCA ' +
        'lleva el prefijo NEXT_PUBLIC_.',
    );
  }
  // Un despiste habitual: pegar la anon key en la variable de service_role.
  if (serviceRoleKey === readEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY')) {
    throw new SupabaseAdminError(
      'SUPABASE_SERVICE_ROLE_KEY contiene la clave ANÓNIMA. Con ella RLS sigue activo y ' +
        'los agentes autónomos no pueden escribir.',
    );
  }
  return { url, serviceRoleKey };
}

/** Crea un cliente admin NUEVO. Úsalo solo cuando necesites uno aislado (pruebas). */
export function createSupabaseAdmin(options: SupabaseAdminOptions = {}): SupabaseClient {
  assertServerOnly();
  const { url, serviceRoleKey } = resolveAdminCredentials(options);

  return createClient(url, serviceRoleKey, {
    auth: {
      // Un agente autónomo no tiene sesión que persistir ni token que refrescar.
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: {
      headers: { 'x-vektora-client': 'service-role' },
    },
  });
}

let singleton: SupabaseClient | null = null;

/** Cliente admin compartido por el proceso. Se construye en la primera llamada. */
export function getSupabaseAdmin(): SupabaseClient {
  if (singleton === null) singleton = createSupabaseAdmin();
  return singleton;
}

/** Solo para pruebas y para recargar tras cambiar el entorno. */
export function resetSupabaseAdmin(): void {
  singleton = null;
}

/** `true` si hay credenciales suficientes, sin llegar a construir el cliente. */
export function isSupabaseAdminConfigured(): boolean {
  try {
    resolveAdminCredentials();
    return true;
  } catch {
    return false;
  }
}

/**
 * Alias de conveniencia: `supabaseAdmin.from('projects')` funciona igual que
 * `getSupabaseAdmin().from('projects')`. Es un Proxy perezoso a propósito — una constante
 * evaluada al importar exigiría credenciales en cualquier proceso que tocara este módulo.
 */
export const supabaseAdmin: SupabaseClient = new Proxy({} as SupabaseClient, {
  get(_target, property, receiver) {
    const client = getSupabaseAdmin() as unknown as Record<string | symbol, unknown>;
    const value = Reflect.get(client, property, receiver);
    return typeof value === 'function' ? value.bind(client) : value;
  },
  has(_target, property) {
    return Reflect.has(getSupabaseAdmin() as unknown as object, property);
  },
});
