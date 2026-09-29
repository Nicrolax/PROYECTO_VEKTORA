/**
 * VEKTORA · FASE 3.5 — Acceso a datos del onboarding de proveedores.
 *
 * Mismo patrón que `lib/planner/repository.ts`: el dominio habla con esta interfaz y nunca
 * con Supabase directamente, así la lógica (resolución de skills, orquestación del alta) se
 * prueba sin base de datos y la persistencia queda en un único sitio auditable.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { ActorType } from '@/lib/supabase/types';

export interface UserRecord {
  id: string;
  email: string | null;
  status: string;
}

/** Fila de `public.skills` tal como la necesita el resolutor. */
export interface SkillRecord {
  id: string;
  slug: string;
  name: string;
  category: string | null;
}

export interface SkillAliasRecord {
  alias: string;
  skillId: string;
  similarity: number | null;
  source: ActorType;
}

/** Cómo se resolvió un slug propuesto contra el catálogo. */
export type SkillMatchKind = 'exact' | 'alias' | 'semantic' | 'created';

export interface ResolvedSkill {
  /** Lo que escribió el proveedor, ya normalizado. */
  proposed: string;
  skillId: string;
  slug: string;
  name: string;
  category: string | null;
  match: SkillMatchKind;
  /** Similitud coseno que justificó un mapeo `semantic`. */
  similarity: number | null;
}

export interface ProviderProfilePayload {
  headline?: string | undefined;
  summary?: string | undefined;
  seniority?: string | undefined;
  hourly_rate_usd?: number | undefined;
  min_task_budget_usd?: number | undefined;
  availability_hours_week?: number | undefined;
  languages?: string[] | undefined;
  timezone?: string | undefined;
  is_active?: boolean | undefined;
  accepts_auto_assign?: boolean | undefined;
}

export interface ProviderSkillLink {
  skill_id: string;
  level: number;
  years_experience?: number | undefined;
}

export interface PersonProfilePayload {
  full_name?: string | undefined;
  display_name?: string | undefined;
  country_code?: string | undefined;
  timezone?: string | undefined;
  locale?: string | undefined;
  bio?: string | undefined;
  website_url?: string | undefined;
}

export interface ProviderRepository {
  findUserById(userId: string): Promise<UserRecord | null>;
  findUserByEmail(email: string): Promise<UserRecord | null>;
  /** Coincidencias exactas de slug. Paso 1 de la cascada: gratis. */
  findSkillsBySlugs(slugs: readonly string[]): Promise<SkillRecord[]>;
  /** Alias ya registrados. Paso 2: también gratis, y evita gastar un embedding. */
  findSkillsByAliases(aliases: readonly string[]): Promise<Map<string, SkillRecord>>;
  /** Paso 3 y 4: vecino semántico o creación. `vector` null salta el paso semántico. */
  resolveOrCreateSkill(params: {
    slug: string;
    name?: string | undefined;
    vector?: string | undefined;
    threshold: number;
  }): Promise<Omit<ResolvedSkill, 'proposed'>>;
  upsertPersonProfile(userId: string, payload: PersonProfilePayload): Promise<void>;
  upsertProviderProfile(userId: string, payload: ProviderProfilePayload): Promise<string>;
  setProviderSkills(providerProfileId: string, links: readonly ProviderSkillLink[]): Promise<number>;
  saveProviderEmbedding(providerProfileId: string, vector: string, model: string): Promise<boolean>;
}

export class ProviderRepositoryError extends Error {
  readonly code: string | undefined;
  readonly details: unknown;

  constructor(message: string, code?: string, details?: unknown) {
    super(message);
    this.name = 'ProviderRepositoryError';
    this.code = code;
    this.details = details;
  }
}

interface PostgrestErrorLike {
  message: string;
  code?: string;
  details?: unknown;
  hint?: unknown;
}

function fail(action: string, error: PostgrestErrorLike): never {
  throw new ProviderRepositoryError(
    `VEKTORA/PROVIDER: ${action} falló -> ${error.message}`,
    error.code,
    error.details ?? error.hint,
  );
}

export class SupabaseProviderRepository implements ProviderRepository {
  constructor(private readonly client: SupabaseClient) {}

  async findUserById(userId: string): Promise<UserRecord | null> {
    const { data, error } = await this.client
      .from('users')
      .select('id, email, status')
      .eq('id', userId)
      .maybeSingle();
    if (error !== null) fail('buscar el usuario', error);
    return data === null ? null : (data as UserRecord);
  }

  async findUserByEmail(email: string): Promise<UserRecord | null> {
    // `users.email` es citext: la comparación ya es insensible a mayúsculas en la base.
    const { data, error } = await this.client
      .from('users')
      .select('id, email, status')
      .eq('email', email)
      .maybeSingle();
    if (error !== null) fail('buscar el usuario por correo', error);
    return data === null ? null : (data as UserRecord);
  }

  async findSkillsBySlugs(slugs: readonly string[]): Promise<SkillRecord[]> {
    if (slugs.length === 0) return [];
    const { data, error } = await this.client
      .from('skills')
      .select('id, slug, name, category')
      .in('slug', [...slugs]);
    if (error !== null) fail('leer el catálogo de skills', error);
    return (data ?? []) as SkillRecord[];
  }

  async findSkillsByAliases(aliases: readonly string[]): Promise<Map<string, SkillRecord>> {
    const out = new Map<string, SkillRecord>();
    if (aliases.length === 0) return out;

    const { data, error } = await this.client
      .from('skill_aliases')
      .select('alias, skills:skill_id (id, slug, name, category)')
      .in('alias', [...aliases]);
    if (error !== null) fail('leer los alias de skills', error);

    for (const row of (data ?? []) as Array<{ alias: string; skills: unknown }>) {
      // PostgREST devuelve la relación como objeto o como array de uno según la cardinalidad.
      const joined = Array.isArray(row.skills) ? row.skills[0] : row.skills;
      if (joined === undefined || joined === null) continue;
      out.set(row.alias.toLowerCase(), joined as SkillRecord);
    }
    return out;
  }

  async resolveOrCreateSkill(params: {
    slug: string;
    name?: string | undefined;
    vector?: string | undefined;
    threshold: number;
  }): Promise<Omit<ResolvedSkill, 'proposed'>> {
    const { data, error } = await this.client.rpc('resolve_or_create_skill', {
      p_slug: params.slug,
      p_name: params.name ?? null,
      p_embedding: params.vector ?? null,
      p_threshold: params.threshold,
    });
    if (error !== null) fail(`resolver la skill "${params.slug}"`, error);

    const payload = (data ?? {}) as {
      skill_id?: string;
      slug?: string;
      name?: string;
      category?: string | null;
      match?: SkillMatchKind;
      similarity?: number | string | null;
    };
    if (typeof payload.skill_id !== 'string') {
      throw new ProviderRepositoryError(
        `VEKTORA/PROVIDER: resolve_or_create_skill no devolvió skill_id para "${params.slug}"`,
      );
    }
    const similarity =
      payload.similarity === null || payload.similarity === undefined
        ? null
        : Number(payload.similarity);

    return {
      skillId: payload.skill_id,
      slug: payload.slug ?? params.slug,
      name: payload.name ?? params.slug,
      category: payload.category ?? null,
      match: payload.match ?? 'created',
      similarity: similarity !== null && Number.isFinite(similarity) ? similarity : null,
    };
  }

  async upsertPersonProfile(userId: string, payload: PersonProfilePayload): Promise<void> {
    const row: Record<string, unknown> = { user_id: userId };
    for (const [key, value] of Object.entries(payload)) {
      if (value !== undefined) row[key] = value;
    }
    // Solo `user_id` significa que no hay nada que actualizar: el trigger de `auth.users`
    // ya creó la fila en el bootstrap.
    if (Object.keys(row).length === 1) return;

    const { error } = await this.client
      .from('profiles')
      .upsert(row, { onConflict: 'user_id' });
    if (error !== null) fail('guardar el perfil personal', error);
  }

  async upsertProviderProfile(userId: string, payload: ProviderProfilePayload): Promise<string> {
    const clean: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(payload)) {
      if (value !== undefined) clean[key] = value;
    }

    const { data, error } = await this.client.rpc('upsert_provider_profile', {
      p_user_id: userId,
      p_payload: clean,
    });
    if (error !== null) fail('guardar el perfil de proveedor', error);
    if (typeof data !== 'string') {
      throw new ProviderRepositoryError(
        'VEKTORA/PROVIDER: upsert_provider_profile no devolvió el id del perfil',
      );
    }
    return data;
  }

  async setProviderSkills(
    providerProfileId: string,
    links: readonly ProviderSkillLink[],
  ): Promise<number> {
    const { data, error } = await this.client.rpc('set_provider_skills', {
      p_provider_profile_id: providerProfileId,
      p_skills: links.map((link) => ({
        skill_id: link.skill_id,
        level: link.level,
        years_experience: link.years_experience ?? null,
      })),
    });
    if (error !== null) fail('vincular las skills del proveedor', error);
    return typeof data === 'number' ? data : links.length;
  }

  async saveProviderEmbedding(
    providerProfileId: string,
    vector: string,
    model: string,
  ): Promise<boolean> {
    const { error } = await this.client
      .from('provider_profiles')
      .update({
        embedding: vector,
        embedding_model: model,
        embedding_updated_at: new Date().toISOString(),
      })
      .eq('id', providerProfileId);

    // Un embedding que no se guarda degrada el matching de la FASE 4, pero no invalida el
    // alta: el proveedor existe y el ranking determinista sigue funcionando.
    if (error !== null) {
      console.warn(`[vektora/provider] embedding del perfil: ${error.message}`);
      return false;
    }
    return true;
  }
}
