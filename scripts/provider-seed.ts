/**
 * VEKTORA — Alta de proveedores de prueba, por el camino REAL.
 *
 *   npm run provider:seed            # crea las cuentas y los perfiles
 *   npm run provider:seed -- --purge # las borra todas
 *
 * Por qué existe: con una sola cuenta el matching es estructuralmente inverificable. El
 * dueño de un proyecto no puede ser proveedor de sus propias tareas —regla de negocio
 * correcta— así que hacen falta OTRAS personas para que el ranking tenga algo que ordenar.
 *
 * No inserta filas a mano: crea cuentas reales en Supabase Auth (el trigger del bootstrap
 * las proyecta a `public.users` y `profiles`) y las da de alta con el mismo
 * `ProviderOnboarding` que usará el formulario de la FASE 6. Si este script funciona, el
 * camino real funciona.
 *
 * Todas las cuentas llevan el prefijo `vektora.seed.` para poder borrarlas sin tocar nada
 * más. `--purge` las elimina de `auth.users` y la cascada se lleva perfiles, skills y
 * candidaturas.
 */

import '@/lib/env';

import { randomUUID } from 'node:crypto';
import { errorMessage } from '@/lib/ai/errors';
import { createProviderOnboarding, describeResolution } from '@/lib/providers';
import type { RegisterProviderInput } from '@/lib/providers';
import { getSupabaseAdmin, resolveAdminCredentials } from '@/lib/supabase/admin';

const SEED_PREFIX = 'vektora.seed.';

interface SeedProvider {
  slug: string;
  fullName: string;
  input: Omit<RegisterProviderInput, 'email'>;
  /** Eventos de reputación a sembrar. Vacío = proveedor sin historial (arranque en frío). */
  reputation: Array<{ type: string; delta: number; reason: string }>;
}

/**
 * Cuatro perfiles con solapamientos DISTINTOS contra el plan típico de un micrositio, para
 * que el ranking tenga que discriminar de verdad y no gane siempre el mismo.
 */
const SEEDS: SeedProvider[] = [
  {
    slug: 'frontend',
    fullName: 'Paula Ferreira',
    input: {
      person: { fullName: 'Paula Ferreira', countryCode: 'UY', timezone: 'America/Montevideo' },
      provider: {
        headline: 'Ingeniera front-end especializada en Next.js, React y accesibilidad',
        summary:
          'Ocho años construyendo interfaces de producto con React y Next.js. App Router, ' +
          'Server Actions, Tailwind y sistemas de diseño accesibles WCAG AA. He liderado ' +
          'migraciones de SPA a renderizado híbrido en equipos de cinco a quince personas.',
        seniority: 'senior',
        hourlyRateUsd: 55,
        availabilityHoursWeek: 25,
        languages: ['es', 'en'],
      },
      skills: [
        { slug: 'nextjs', level: 5, yearsExperience: 5 },
        { slug: 'react', level: 5, yearsExperience: 8 },
        { slug: 'typescript', level: 5, yearsExperience: 7 },
        { slug: 'tailwind-css', level: 4, yearsExperience: 4 },
      ],
    },
    reputation: [
      { type: 'onboarding_bonus', delta: 5, reason: 'alta verificada' },
      { type: 'task_completed', delta: 20, reason: 'landing entregada a tiempo' },
      { type: 'task_completed', delta: 20, reason: 'migración a App Router' },
      { type: 'deliverable_approved', delta: 15, reason: 'aprobado sin correcciones' },
    ],
  },
  {
    slug: 'diseno',
    fullName: 'Martín Acosta',
    input: {
      person: { fullName: 'Martín Acosta', countryCode: 'AR', timezone: 'America/Argentina/Buenos_Aires' },
      provider: {
        headline: 'Diseñador de producto: investigación UX, wireframes e interfaz visual',
        summary:
          'Diseño de producto de punta a punta: entrevistas, arquitectura de información, ' +
          'wireframes de baja fidelidad y diseño visual de alta fidelidad con sistemas de ' +
          'componentes. Trabajo en Figma y entrego assets listos para implementar.',
        seniority: 'senior',
        hourlyRateUsd: 45,
        availabilityHoursWeek: 30,
        languages: ['es'],
      },
      skills: [
        { slug: 'ux-research', level: 5, yearsExperience: 6 },
        { slug: 'ui-design', level: 5, yearsExperience: 7 },
        { slug: 'graphic-design', level: 4, yearsExperience: 5 },
      ],
    },
    reputation: [
      { type: 'onboarding_bonus', delta: 5, reason: 'alta verificada' },
      { type: 'task_completed', delta: 20, reason: 'sistema de diseño entregado' },
    ],
  },
  {
    slug: 'datos',
    fullName: 'Lucía Méndez',
    input: {
      person: { fullName: 'Lucía Méndez', countryCode: 'UY', timezone: 'America/Montevideo' },
      provider: {
        headline: 'Ingeniera de datos y back-end sobre Supabase y PostgreSQL',
        summary:
          'Modelado de datos, PostgreSQL, Row Level Security y pipelines de ingesta. ' +
          'Diseño esquemas pensados para que las políticas de acceso sean simples y ' +
          'auditables, y automatizo despliegues de base con migraciones idempotentes.',
        seniority: 'mid',
        hourlyRateUsd: 40,
        availabilityHoursWeek: 20,
        languages: ['es', 'en'],
      },
      skills: [
        { slug: 'supabase', level: 5, yearsExperience: 3 },
        { slug: 'postgresql', level: 5, yearsExperience: 6 },
        { slug: 'data-engineering', level: 4, yearsExperience: 4 },
        { slug: 'devops', level: 3, yearsExperience: 2 },
      ],
    },
    // Sin historial a propósito: ejercita el prior neutro y el arranque en frío.
    reputation: [],
  },
  {
    slug: 'contenido',
    fullName: 'Sofía Rivas',
    input: {
      person: { fullName: 'Sofía Rivas', countryCode: 'ES', timezone: 'Europe/Madrid' },
      provider: {
        headline: 'Estrategia de contenido, redacción técnica y gestión de proyectos digitales',
        summary:
          'Defino alcance y requisitos de proyectos digitales y escribo el contenido que ' +
          'los sostiene: copy de producto, documentación técnica y medición de embudos de ' +
          'captación. Coordino equipos pequeños con entregas quincenales.',
        seniority: 'senior',
        hourlyRateUsd: 38,
        availabilityHoursWeek: 15,
        languages: ['es', 'en'],
      },
      skills: [
        { slug: 'project-management', level: 5, yearsExperience: 8 },
        { slug: 'technical-writing', level: 5, yearsExperience: 6 },
        { slug: 'copywriting', level: 4, yearsExperience: 5 },
        { slug: 'growth-marketing', level: 3, yearsExperience: 3 },
      ],
    },
    reputation: [
      { type: 'onboarding_bonus', delta: 5, reason: 'alta verificada' },
      { type: 'task_completed', delta: 20, reason: 'documentación de producto' },
      { type: 'deadline_met', delta: 10, reason: 'entrega anticipada' },
    ],
  },
];

const seedEmail = (slug: string): string => `${SEED_PREFIX}${slug}@vektora.example`;

interface AdminUser {
  id: string;
  email?: string;
}

async function createAuthUser(fullName: string, email: string): Promise<AdminUser> {
  const { url, serviceRoleKey } = resolveAdminCredentials();
  const response = await fetch(`${url.replace(/\/+$/, '')}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      apikey: serviceRoleKey,
      authorization: `Bearer ${serviceRoleKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      email,
      // Contraseña aleatoria que no se imprime: estas cuentas no están pensadas para
      // iniciar sesión, solo para existir como proveedores.
      password: randomUUID(),
      email_confirm: true,
      user_metadata: { full_name: fullName, role: 'provider' },
    }),
  });

  const body = (await response.json()) as AdminUser & { msg?: string; message?: string };
  if (!response.ok) {
    throw new Error(`${response.status} ${body.msg ?? body.message ?? 'error desconocido'}`);
  }
  return body;
}

async function deleteAuthUser(id: string): Promise<void> {
  const { url, serviceRoleKey } = resolveAdminCredentials();
  const response = await fetch(`${url.replace(/\/+$/, '')}/auth/v1/admin/users/${id}`, {
    method: 'DELETE',
    headers: { apikey: serviceRoleKey, authorization: `Bearer ${serviceRoleKey}` },
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`${response.status} ${(await response.text()).slice(0, 160)}`);
  }
}

async function purge(): Promise<void> {
  console.log('\n=== VEKTORA · borrando proveedores de prueba ===\n');
  const client = getSupabaseAdmin();

  const { data, error } = await client
    .from('users')
    .select('id, email')
    .like('email', `${SEED_PREFIX}%`);
  if (error !== null) {
    console.error(`No se pudieron listar -> ${error.message}\n`);
    process.exitCode = 1;
    return;
  }

  const users = (data ?? []) as Array<{ id: string; email: string | null }>;
  if (users.length === 0) {
    console.log('No hay cuentas de prueba que borrar.\n');
    return;
  }

  for (const user of users) {
    try {
      await deleteAuthUser(user.id);
      console.log(`  ✓ ${user.email ?? user.id}`);
    } catch (deleteError) {
      console.log(`  ✗ ${user.email ?? user.id}: ${errorMessage(deleteError)}`);
    }
  }
  console.log(
    `\n${users.length} cuenta(s) eliminadas. La cascada de auth.users se lleva perfiles,\n` +
      'skills y candidaturas asociadas.\n',
  );
}

async function seed(): Promise<void> {
  console.log('\n=== VEKTORA · proveedores de prueba ===\n');
  console.log('Se crean por el camino real: cuenta en Supabase Auth + ProviderOnboarding.\n');

  const client = getSupabaseAdmin();
  const onboarding = createProviderOnboarding();
  let created = 0;

  for (const entry of SEEDS) {
    const email = seedEmail(entry.slug);
    console.log(`\n── ${entry.fullName}  <${email}>`);

    let userId: string;
    const existing = await client.from('users').select('id').eq('email', email).maybeSingle();

    if (existing.data !== null) {
      userId = String((existing.data as { id: unknown }).id);
      console.log('   cuenta ya existente: se actualiza el perfil');
    } else {
      try {
        const authUser = await createAuthUser(entry.fullName, email);
        userId = authUser.id;
        console.log('   cuenta creada en Supabase Auth');
      } catch (error) {
        console.log(`   ✗ no se pudo crear la cuenta -> ${errorMessage(error)}`);
        continue;
      }
    }

    try {
      const result = await onboarding.register({ ...entry.input, userId });
      for (const description of describeResolution(result.skills)) {
        console.log(`   · ${description}`);
      }
      console.log(
        `   skills vinculadas: ${result.linkedSkills} · ` +
          `perfil vectorizado: ${result.profileEmbedded ? 'sí' : 'no'}`,
      );

      // La reputación se siembra por su libro mayor, no escribiendo el marcador: el
      // trigger `apply_reputation_event` proyecta el total en provider_profiles, igual
      // que ocurrirá en producción.
      if (entry.reputation.length > 0) {
        const rows = entry.reputation.map((event) => ({
          user_id: userId,
          event_type: event.type,
          delta: event.delta,
          reason: event.reason,
          actor_type: 'system',
        }));
        const inserted = await client.from('reputation_events').insert(rows);
        if (inserted.error !== null) {
          console.log(`   aviso: reputación no sembrada -> ${inserted.error.message}`);
        } else {
          const total = entry.reputation.reduce((sum, event) => sum + event.delta, 0);
          console.log(`   reputación sembrada: ${entry.reputation.length} eventos (+${total})`);
        }
      } else {
        console.log('   sin historial: ejercita el prior neutro del ranking');
      }
      created += 1;
    } catch (error) {
      console.log(`   ✗ alta fallida -> ${errorMessage(error)}`);
    }
  }

  console.log(`\n${created}/${SEEDS.length} proveedores listos.\n`);
  console.log('Siguiente:');
  console.log('  npm run match                     # lista las tareas emparejables');
  console.log('  npm run match -- <task_id> --dry-run');
  console.log('\nPara borrarlos: npm run provider:seed -- --purge\n');
}

async function main(): Promise<void> {
  if (process.argv.includes('--purge')) {
    await purge();
    return;
  }
  await seed();
}

main().catch((error: unknown) => {
  console.error(`\nVEKTORA/PROVIDER: falló -> ${errorMessage(error)}\n`);
  process.exitCode = 1;
});
