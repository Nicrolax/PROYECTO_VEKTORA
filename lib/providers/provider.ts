/**
 * VEKTORA · FASE 3.5 — Onboarding de proveedores.
 *
 * Alta o actualización completa de un proveedor, en este orden:
 *   1. Verificar que la cuenta existe en `public.users` y está activa.
 *   2. Guardar el perfil personal (`profiles`) y el de ejecución (`provider_profiles`).
 *   3. Resolver las skills declaradas contra el catálogo vivo.
 *   4. Vincularlas (`provider_skills`).
 *   5. Vectorizar el perfil para la búsqueda semántica de la FASE 4.
 *
 * El paso 5 es el único que puede fallar sin abortar: sin embedding el proveedor sigue
 * siendo emparejable por el ranking determinista de skills y reputación. Se degrada, no
 * se falla — el mismo criterio que en el planificador.
 */

import { getEmbeddingService, toPgVector, type EmbeddingService } from '@/lib/ai/embeddings';
import { errorMessage, isAiError } from '@/lib/ai/errors';
import type {
  PersonProfilePayload,
  ProviderProfilePayload,
  ProviderRepository,
  ResolvedSkill,
} from './repository';
import { RegisterProviderSchema, type RegisterProviderInput } from './schemas';
import { SkillResolver } from './skills';

export class ProviderError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ProviderError';
  }
}

export interface RegisterProviderResult {
  userId: string;
  providerProfileId: string;
  skills: ResolvedSkill[];
  /** Skills que no existían y se crearon: el catálogo creció con esta alta. */
  createdSkills: string[];
  linkedSkills: number;
  /** Cuántos slugs necesitaron un embedding para resolverse. */
  embeddedSkills: number;
  /** true si se pudo vectorizar el perfil para el matching de la FASE 4. */
  profileEmbedded: boolean;
  /** true si la resolución semántica no estuvo disponible. */
  degraded: boolean;
}

export interface ProviderOnboardingOptions {
  repository: ProviderRepository;
  embeddings?: EmbeddingService | null;
  resolver?: SkillResolver;
}

export class ProviderOnboarding {
  private readonly repository: ProviderRepository;
  private readonly embeddings: EmbeddingService | null;
  private readonly resolver: SkillResolver;

  constructor(options: ProviderOnboardingOptions) {
    this.repository = options.repository;
    this.embeddings =
      options.embeddings !== undefined ? options.embeddings : getEmbeddingService();
    this.resolver =
      options.resolver ??
      new SkillResolver({
        repository: options.repository,
        embeddings: this.embeddings,
      });
  }

  async register(input: RegisterProviderInput): Promise<RegisterProviderResult> {
    const parsed = RegisterProviderSchema.safeParse(input);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(raíz)'}: ${issue.message}`)
        .join('; ');
      throw new ProviderError(`VEKTORA/PROVIDER: alta inválida -> ${detail}`);
    }
    const data = parsed.data;

    // --- 1. Cuenta ----------------------------------------------------------------------
    const user = await this.resolveUser(data.userId, data.email);

    // --- 2. Perfiles --------------------------------------------------------------------
    if (data.person !== undefined) {
      await this.repository.upsertPersonProfile(user.id, toPersonPayload(data.person));
    }
    const providerProfileId = await this.repository.upsertProviderProfile(
      user.id,
      toProviderPayload(data.provider),
    );

    // --- 3. Skills contra el catálogo vivo ------------------------------------------------
    const resolution = await this.resolver.resolve(
      data.skills.map((skill) => ({ slug: skill.slug, name: skill.name })),
    );

    // Dos declaraciones distintas pueden resolver a la MISMA skill (`reactjs` y `react-18`
    // -> `react`). Se quedan con el nivel y la experiencia más altos declarados: rebajar la
    // competencia de alguien por un detalle de ortografía sería un error.
    const bySkillId = new Map<string, { level: number; years?: number | undefined }>();
    data.skills.forEach((declared, index) => {
      const resolved = resolution.resolved[index];
      if (resolved === undefined) return;
      const previous = bySkillId.get(resolved.skillId);
      const level = Math.max(previous?.level ?? 0, declared.level ?? 3);
      const years = maxDefined(previous?.years, declared.yearsExperience);
      bySkillId.set(resolved.skillId, { level, ...(years === undefined ? {} : { years }) });
    });

    // --- 4. Vínculos ----------------------------------------------------------------------
    const linkedSkills = await this.repository.setProviderSkills(
      providerProfileId,
      [...bySkillId.entries()].map(([skillId, entry]) => ({
        skill_id: skillId,
        level: entry.level,
        years_experience: entry.years,
      })),
    );

    // --- 5. Vectorización del perfil (FASE 4) ----------------------------------------------
    const profileEmbedded =
      data.embedProfile === false
        ? false
        : await this.embedProfile(providerProfileId, data.provider, resolution.resolved);

    return {
      userId: user.id,
      providerProfileId,
      skills: resolution.resolved,
      createdSkills: resolution.resolved
        .filter((skill) => skill.match === 'created')
        .map((skill) => skill.slug),
      linkedSkills,
      embeddedSkills: resolution.embedded,
      profileEmbedded,
      degraded: resolution.degraded,
    };
  }

  // -------------------------------------------------------------------------------------

  private async resolveUser(
    userId: string | undefined,
    email: string | undefined,
  ): Promise<{ id: string }> {
    const found =
      userId !== undefined
        ? await this.repository.findUserById(userId)
        : email !== undefined
          ? await this.repository.findUserByEmail(email)
          : null;

    if (found === null) {
      const reference = userId ?? email ?? '(sin referencia)';
      throw new ProviderError(
        `VEKTORA/PROVIDER: no existe la cuenta ${reference} en public.users. Créala en ` +
          'Supabase Auth: el trigger del bootstrap la proyecta a public.users.',
      );
    }
    if (found.status !== 'active') {
      throw new ProviderError(
        `VEKTORA/PROVIDER: la cuenta ${found.id} está en estado "${found.status}" y no puede ` +
          'ofrecer servicios.',
      );
    }
    return { id: found.id };
  }

  /**
   * Vectoriza el perfil para el matching de la FASE 4. El texto incluye las skills
   * RESUELTAS (no las declaradas) porque son las que comparten vocabulario con
   * `project_tasks.required_skills`, que es contra lo que se compara.
   */
  private async embedProfile(
    providerProfileId: string,
    profile: { headline: string; summary: string; seniority?: string | undefined },
    skills: readonly ResolvedSkill[],
  ): Promise<boolean> {
    const embeddings = this.embeddings;
    if (embeddings === null || !embeddings.isAvailable()) return false;

    try {
      const response = await embeddings.embedTexts({
        texts: [renderProviderForEmbedding(profile, skills)],
        taskType: 'RETRIEVAL_DOCUMENT',
      });
      const vector = response.vectors[0];
      if (vector === undefined) return false;
      return this.repository.saveProviderEmbedding(
        providerProfileId,
        toPgVector(vector, response.dimensions),
        response.model,
      );
    } catch (error) {
      const detail = isAiError(error) ? error.code : errorMessage(error);
      console.warn(`[vektora/provider] perfil sin vectorizar: ${detail}`);
      return false;
    }
  }
}

/**
 * Texto que representa al proveedor en el espacio vectorial. Debe ser simétrico con
 * `renderTaskForEmbedding` del planificador: título/titular, descripción/resumen y skills.
 * Si las dos representaciones no son comparables, la distancia coseno no significa nada.
 */
export function renderProviderForEmbedding(
  profile: { headline: string; summary: string; seniority?: string | undefined },
  skills: readonly ResolvedSkill[],
): string {
  const lines = [profile.headline, profile.summary];
  if (profile.seniority !== undefined) lines.push(`Seniority: ${profile.seniority}`);
  lines.push(`Skills: ${skills.map((skill) => skill.slug).join(', ')}`);
  return lines.join('\n');
}

function toProviderPayload(input: {
  headline: string;
  summary: string;
  seniority?: string | undefined;
  hourlyRateUsd?: number | undefined;
  minTaskBudgetUsd?: number | undefined;
  availabilityHoursWeek?: number | undefined;
  languages: string[];
  timezone?: string | undefined;
  isActive: boolean;
  acceptsAutoAssign: boolean;
}): ProviderProfilePayload {
  return {
    headline: input.headline,
    summary: input.summary,
    seniority: input.seniority,
    hourly_rate_usd: input.hourlyRateUsd,
    min_task_budget_usd: input.minTaskBudgetUsd,
    availability_hours_week: input.availabilityHoursWeek,
    languages: input.languages.length > 0 ? input.languages : undefined,
    timezone: input.timezone,
    is_active: input.isActive,
    accepts_auto_assign: input.acceptsAutoAssign,
  };
}

function toPersonPayload(input: {
  fullName?: string | undefined;
  displayName?: string | undefined;
  countryCode?: string | undefined;
  timezone?: string | undefined;
  locale?: string | undefined;
  bio?: string | undefined;
  websiteUrl?: string | undefined;
}): PersonProfilePayload {
  return {
    full_name: input.fullName,
    display_name: input.displayName,
    country_code: input.countryCode?.toUpperCase(),
    timezone: input.timezone,
    locale: input.locale,
    bio: input.bio,
    website_url: input.websiteUrl,
  };
}

function maxDefined(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.max(a, b);
}
