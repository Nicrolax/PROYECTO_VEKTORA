/**
 * VEKTORA · FASE 3.5 — API pública del onboarding de proveedores.
 *
 *   import { createProviderOnboarding } from '@/lib/providers';
 *
 *   const result = await createProviderOnboarding().register({
 *     email: 'proveedora@ejemplo.com',
 *     provider: { headline: '…', summary: '…' },
 *     skills: [{ slug: 'React 18' }, { slug: 'nextjs' }],
 *   });
 *
 * Sin argumentos usa Supabase con el cliente `service_role`. Inyectando `repository` se
 * prueba todo el dominio sin red ni base de datos.
 */

import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { ProviderOnboarding, type ProviderOnboardingOptions } from './provider';
import { SupabaseProviderRepository } from './repository';

export {
  ProviderError,
  ProviderOnboarding,
  renderProviderForEmbedding,
} from './provider';
export type { ProviderOnboardingOptions, RegisterProviderResult } from './provider';

export {
  ProviderRepositoryError,
  SupabaseProviderRepository,
} from './repository';
export type {
  PersonProfilePayload,
  ProviderProfilePayload,
  ProviderRepository,
  ProviderSkillLink,
  ResolvedSkill,
  SkillAliasRecord,
  SkillMatchKind,
  SkillRecord,
  UserRecord,
} from './repository';

export {
  describeResolution,
  renderSkillForEmbedding,
  resolveThreshold,
  SkillResolver,
} from './skills';
export type { ResolveSkillsResult, SkillProposal, SkillResolverOptions } from './skills';

export {
  DEFAULT_SKILL_MATCH_THRESHOLD,
  MAX_SKILLS,
  MIN_SKILLS,
  normalizeSkillSlug,
  PersonProfileInputSchema,
  ProposedSkillSchema,
  ProviderProfileInputSchema,
  RegisterProviderSchema,
  SKILL_SLUG_RE,
} from './schemas';
export type {
  PersonProfileInput,
  ProposedSkill,
  ProviderProfileInput,
  RegisterProviderData,
  RegisterProviderInput,
} from './schemas';

/** Construye el onboarding listo para usar contra Supabase con `service_role`. */
export function createProviderOnboarding(
  options: Partial<ProviderOnboardingOptions> = {},
): ProviderOnboarding {
  const repository = options.repository ?? new SupabaseProviderRepository(getSupabaseAdmin());
  return new ProviderOnboarding({
    repository,
    ...(options.embeddings === undefined ? {} : { embeddings: options.embeddings }),
    ...(options.resolver === undefined ? {} : { resolver: options.resolver }),
  });
}
