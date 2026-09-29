import type { NextConfig } from 'next';

/**
 * VEKTORA · FASE 6 — Configuración de Next.js.
 *
 * `serverExternalPackages` mantiene `@supabase/supabase-js` fuera del empaquetado del
 * servidor. Sin eso, el empaquetador puede arrastrar el módulo del cliente `service_role`
 * a sitios donde no debería estar, y la frontera que separa a los agentes autónomos del
 * navegador deja de ser evidente al leer el código.
 */
const config: NextConfig = {
  reactStrictMode: true,
  serverExternalPackages: ['@supabase/supabase-js'],
  typedRoutes: true,
};

export default config;
