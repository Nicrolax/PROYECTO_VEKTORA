/**
 * VEKTORA · FASE 3.5 — Alta de un proveedor real, de punta a punta.
 *
 *   npm run provider:add -- ./perfil.json
 *   npm run provider:add -- --ejemplo > perfil.json
 *
 * El JSON es el mismo contrato que consumirá el formulario de la FASE 6: cuando exista la
 * interfaz, llamará a `createProviderOnboarding().register(...)` con este mismo objeto.
 * No hay dos caminos de alta, hay uno con dos envoltorios.
 *
 * Requiere que la cuenta ya exista en `public.users` (se crea en Supabase Auth y el trigger
 * del bootstrap la proyecta). No imprime ninguna clave.
 */

import '@/lib/env';

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { errorMessage } from '@/lib/ai/errors';
import { createProviderOnboarding, describeResolution } from '@/lib/providers';
import type { RegisterProviderInput } from '@/lib/providers';

const EJEMPLO: RegisterProviderInput = {
  email: 'proveedora@ejemplo.com',
  person: {
    fullName: 'Nombre Apellido',
    countryCode: 'UY',
    timezone: 'America/Montevideo',
    locale: 'es',
  },
  provider: {
    headline: 'Ingeniera front-end especializada en Next.js y accesibilidad',
    summary:
      'Ocho años construyendo interfaces de producto con React y Next.js. Trabajo con ' +
      'App Router, Server Actions y sistemas de diseño accesibles (WCAG AA). He liderado ' +
      'migraciones de SPA a renderizado híbrido en equipos de cinco a quince personas.',
    seniority: 'senior',
    hourlyRateUsd: 55,
    minTaskBudgetUsd: 300,
    availabilityHoursWeek: 25,
    languages: ['es', 'en'],
    timezone: 'America/Montevideo',
  },
  // A propósito escritas "mal": el resolutor las normaliza y las mapea al catálogo.
  skills: [
    { slug: 'React 18', level: 5, yearsExperience: 8 },
    { slug: 'nextjs', level: 5, yearsExperience: 5 },
    { slug: 'Tailwind CSS', level: 4 },
    { slug: 'accesibilidad-web', name: 'Accesibilidad Web', level: 4 },
  ],
};

function line(label: string, value: string): void {
  console.log(`  ${label.padEnd(24)} ${value}`);
}

async function main(): Promise<void> {
  if (process.argv.includes('--ejemplo')) {
    console.log(JSON.stringify(EJEMPLO, null, 2));
    return;
  }

  const path = process.argv[2];
  if (path === undefined || path.trim() === '') {
    console.error(
      '\nUso: npm run provider:add -- <ruta-al-json>\n' +
        '     npm run provider:add -- --ejemplo > perfil.json\n',
    );
    process.exitCode = 1;
    return;
  }

  let input: RegisterProviderInput;
  try {
    input = JSON.parse(readFileSync(resolve(path), 'utf8')) as RegisterProviderInput;
  } catch (error) {
    console.error(`\nNo se pudo leer "${path}" -> ${errorMessage(error)}\n`);
    process.exitCode = 1;
    return;
  }

  console.log('\n=== VEKTORA · FASE 3.5 · alta de proveedor ===\n');

  const started = Date.now();
  const result = await createProviderOnboarding().register(input);

  console.log('[1] Cuenta y perfil');
  line('user_id:', result.userId);
  line('provider_profile_id:', result.providerProfileId);
  console.log();

  console.log('[2] Resolución de skills contra el catálogo');
  for (const description of describeResolution(result.skills)) {
    console.log(`  · ${description}`);
  }
  console.log();

  console.log('[3] Resumen');
  line('skills vinculadas:', String(result.linkedSkills));
  line(
    'nuevas en catálogo:',
    result.createdSkills.length > 0 ? result.createdSkills.join(', ') : '(ninguna)',
  );
  line('embeddings gastados:', `${result.embeddedSkills} (solo los slugs desconocidos)`);
  line('perfil vectorizado:', result.profileEmbedded ? 'sí' : 'no');
  if (result.degraded) {
    line('aviso:', 'sin paso semántico; se resolvió por slug exacto y alias');
  }
  line('tiempo total:', `${Date.now() - started} ms`);

  console.log('\n=== Proveedor dado de alta ===\n');
}

main().catch((error: unknown) => {
  console.error(`\nVEKTORA/PROVIDER: falló -> ${errorMessage(error)}\n`);
  process.exitCode = 1;
});
