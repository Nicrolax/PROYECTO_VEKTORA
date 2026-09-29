-- =====================================================================================
-- VEKTORA · FASE 3.5 — Onboarding de proveedores y catálogo vivo de skills
-- =====================================================================================
-- Aplicar DESPUÉS de db/migrations/0002_planner.sql. Idempotente.
--
-- PROBLEMA QUE RESUELVE
-- --------------------
-- Los proveedores se registran solos y declaran sus propias skills. Si cada uno inventa el
-- slug, el vocabulario se dispersa: `react`, `reactjs`, `react-18` y `React.js` son cuatro
-- filas distintas para la misma competencia. El planificador pide `react` en
-- `required_skills` y tres de cada cuatro proveedores dejan de ser emparejables — no por
-- falta de competencia, sino por ortografía. Con 500 proveedores el motor de la FASE 4
-- devuelve listas vacías y nadie entiende por qué.
--
-- SOLUCIÓN: NORMALIZACIÓN SEMÁNTICA
-- ---------------------------------
-- Se vectoriza el slug propuesto y se compara con el catálogo por distancia coseno. Si se
-- parece lo suficiente a una skill existente, se MAPEA a ella y el mapeo queda registrado
-- en `skill_aliases` para que la próxima vez sea una búsqueda exacta y gratis. Solo un
-- concepto genuinamente nuevo crea fila.
--
-- El vocabulario crece solo, sin moderación humana (regla 1 del proyecto), pero CONVERGE
-- en vez de dispersarse.
--
-- Contenido:
--   01 · `skills.embedding` + índice HNSW
--   02 · `skill_aliases` (traza auditable de cada mapeo)
--   03 · `normalize_skill_slug` — normalización léxica, la primera barrera
--   04 · `resolve_or_create_skill` — exacta -> alias -> semántica -> creación
--   05 · `upsert_provider_profile` y `set_provider_skills`
--   06 · RLS y privilegios
-- =====================================================================================

set search_path = public, extensions;


-- =====================================================================================
-- 01 · Vectorización del catálogo
-- =====================================================================================
-- Mismo tamaño y mismo modelo que `project_tasks.embedding` y
-- `provider_profiles.embedding`: los tres espacios tienen que ser comparables.

alter table public.skills
  add column if not exists embedding            vector(1536),
  add column if not exists embedding_model      text,
  add column if not exists embedding_updated_at timestamptz;

-- Parcial, como los otros dos: la consulta de resolución debe incluir
-- `where embedding is not null` y ordenar por `<=>` o no se usará el índice.
create index if not exists idx_skills_embedding_hnsw
  on public.skills using hnsw (embedding vector_cosine_ops)
  with (m = 16, ef_construction = 64)
  where embedding is not null;


-- =====================================================================================
-- 02 · skill_aliases — memoria de los mapeos
-- =====================================================================================
-- Dos funciones: que la segunda vez que alguien escriba `reactjs` la resolución sea una
-- búsqueda exacta (sin gastar un embedding del free tier), y que cada decisión automática
-- quede auditada. En un sistema sin humanos, "por qué se mapeó esto así" tiene que poder
-- responderse.

create table if not exists public.skill_aliases (
  id         uuid primary key default uuid_generate_v4(),
  alias      citext not null unique,
  skill_id   uuid   not null references public.skills (id) on delete cascade,
  /** Similitud coseno que justificó el mapeo. NULL si fue un alias declarado a mano. */
  similarity numeric(6, 5),
  source     actor_type not null default 'ai_agent',
  created_at timestamptz not null default now(),
  constraint skill_aliases_similarity_range
    check (similarity is null or (similarity >= 0 and similarity <= 1))
);

create index if not exists idx_skill_aliases_skill on public.skill_aliases (skill_id);


-- =====================================================================================
-- 03 · normalize_skill_slug — la barrera barata
-- =====================================================================================
-- `React 18` y `react-18` tienen que colapsar ANTES de gastar un embedding. Esta función
-- resuelve la mayoría de los casos sin tocar la red.

create or replace function public.normalize_skill_slug(p_raw text)
returns text
language sql
immutable
as $function$
  select nullif(
    regexp_replace(
      regexp_replace(
        regexp_replace(lower(btrim(coalesce(p_raw, ''))), '[^a-z0-9]+', '-', 'g'),
        '-{2,}', '-', 'g'
      ),
      '^-|-$', '', 'g'
    ),
    ''
  );
$function$;

comment on function public.normalize_skill_slug(text) is
  'Slug canónico: minúsculas, separadores colapsados a un guion, sin guiones al borde.';


-- =====================================================================================
-- 04 · resolve_or_create_skill — el corazón del catálogo vivo
-- =====================================================================================
-- Cascada de cuatro pasos, de más barato a más caro:
--   1. coincidencia EXACTA de slug        -> `exact`
--   2. alias ya registrado                -> `alias`
--   3. vecino más cercano sobre el umbral -> `semantic`  (y se guarda el alias)
--   4. nada se parece                     -> `created`   (categoría `auto`)
--
-- SECURITY DEFINER a propósito: un proveedor autenticado NO tiene INSERT sobre
-- `public.skills` (lo impide `skills_write_admin`), y no debe tenerlo — podría escribir
-- cualquier cosa en el catálogo. Pero sí puede ampliarlo A TRAVÉS DE ESTA FUNCIÓN, que
-- normaliza, deduplica y deja traza. Es la diferencia entre dar permiso y dar un camino.
--
-- `p_embedding` viaja como TEXTO (el literal de pgvector) porque PostgREST no sabe
-- serializar el tipo `vector`. Si llega NULL se salta el paso semántico: el sistema
-- degrada a exacto+alias+creación en vez de fallar.

create or replace function public.resolve_or_create_skill(
  p_slug      text,
  p_name      text    default null,
  p_embedding text    default null,
  p_threshold numeric default 0.82
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'extensions', 'pg_temp'
as $function$
declare
  v_slug       text;
  v_skill      public.skills%rowtype;
  v_similarity numeric;
  v_vector     vector(1536);
  -- El vecino semántico se recoge en escalares y no en el %rowtype: PL/pgSQL no admite
  -- una variable de registro dentro de un INTO con varios destinos (SQLSTATE 42601), y la
  -- consulta necesita traer la similitud calculada junto a las columnas.
  v_near_id       uuid;
  v_near_slug     citext;
  v_near_name     text;
  v_near_category text;
begin
  v_slug := public.normalize_skill_slug(p_slug);
  if v_slug is null then
    raise exception 'VEKTORA/SKILLS: el slug propuesto queda vacío tras normalizar (%)', p_slug
      using errcode = '22023';
  end if;

  -- 1) Coincidencia exacta.
  select * into v_skill from public.skills where slug = v_slug limit 1;
  if found then
    return jsonb_build_object(
      'skill_id', v_skill.id, 'slug', v_skill.slug::text, 'name', v_skill.name,
      'category', v_skill.category, 'match', 'exact', 'similarity', 1.0
    );
  end if;

  -- 2) Alias ya conocido: la segunda vez que alguien escribe `reactjs` no cuesta nada.
  select s.* into v_skill
  from public.skill_aliases a
  join public.skills s on s.id = a.skill_id
  where a.alias = v_slug
  limit 1;
  if found then
    return jsonb_build_object(
      'skill_id', v_skill.id, 'slug', v_skill.slug::text, 'name', v_skill.name,
      'category', v_skill.category, 'match', 'alias', 'similarity', null
    );
  end if;

  -- 3) Vecino más cercano por distancia coseno.
  if p_embedding is not null and btrim(p_embedding) <> '' then
    begin
      v_vector := p_embedding::vector(1536);
    exception when others then
      raise exception 'VEKTORA/SKILLS: p_embedding no es un literal vector(1536) válido'
        using errcode = '22023';
    end;

    select s.id, s.slug, s.name, s.category, 1 - (s.embedding <=> v_vector)
      into v_near_id, v_near_slug, v_near_name, v_near_category, v_similarity
    from public.skills s
    where s.embedding is not null
      and s.is_active
    order by s.embedding <=> v_vector
    limit 1;

    if v_near_id is not null and v_similarity >= p_threshold then
      insert into public.skill_aliases (alias, skill_id, similarity)
      values (v_slug, v_near_id, round(v_similarity, 5))
      on conflict (alias) do nothing;

      return jsonb_build_object(
        'skill_id', v_near_id, 'slug', v_near_slug::text, 'name', v_near_name,
        'category', v_near_category, 'match', 'semantic',
        'similarity', round(v_similarity, 5)
      );
    end if;
  end if;

  -- 4) Concepto nuevo de verdad.
  insert into public.skills (slug, name, category, embedding)
  values (
    v_slug,
    coalesce(nullif(btrim(p_name), ''), initcap(replace(v_slug, '-', ' '))),
    'auto',
    v_vector
  )
  on conflict (slug) do update set name = excluded.name   -- carrera entre dos altas
  returning * into v_skill;

  return jsonb_build_object(
    'skill_id', v_skill.id, 'slug', v_skill.slug::text, 'name', v_skill.name,
    'category', v_skill.category, 'match', 'created',
    'similarity', case when v_similarity is null then null else round(v_similarity, 5) end
  );
end;
$function$;

comment on function public.resolve_or_create_skill(text, text, text, numeric) is
  'Resuelve un slug propuesto contra el catálogo: exacta -> alias -> semántica -> creación.';


-- =====================================================================================
-- 05 · Alta y actualización del proveedor
-- =====================================================================================

-- SECURITY INVOKER (por defecto): `service_role` pasa por encima de RLS, pero un usuario
-- autenticado queda sujeto a `provider_profiles_insert_self` / `_update_self`, así que no
-- puede crear ni tocar el perfil de otro. Cuando llegue la UI de la FASE 6, la misma
-- función sirve sin cambiar una línea.
create or replace function public.upsert_provider_profile(
  p_user_id uuid,
  p_payload jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
set search_path to 'public', 'extensions', 'pg_temp'
as $function$
declare
  v_id uuid;
begin
  if p_user_id is null then
    raise exception 'VEKTORA/PROVIDER: p_user_id es obligatorio' using errcode = '22004';
  end if;

  insert into public.provider_profiles as pp (
    user_id, headline, summary, seniority, hourly_rate_usd, min_task_budget_usd,
    availability_hours_week, languages, timezone, is_active, accepts_auto_assign
  )
  values (
    p_user_id,
    nullif(btrim(coalesce(p_payload ->> 'headline', '')), ''),
    nullif(btrim(coalesce(p_payload ->> 'summary', '')), ''),
    nullif(btrim(coalesce(p_payload ->> 'seniority', '')), ''),
    nullif(p_payload ->> 'hourly_rate_usd', '')::numeric,
    nullif(p_payload ->> 'min_task_budget_usd', '')::numeric,
    nullif(p_payload ->> 'availability_hours_week', '')::integer,
    coalesce(
      (select array_agg(value::text) from jsonb_array_elements_text(p_payload -> 'languages')),
      '{}'::text[]
    ),
    nullif(btrim(coalesce(p_payload ->> 'timezone', '')), ''),
    coalesce(nullif(p_payload ->> 'is_active', '')::boolean, true),
    coalesce(nullif(p_payload ->> 'accepts_auto_assign', '')::boolean, true)
  )
  on conflict (user_id) do update
    -- `coalesce(excluded.x, pp.x)`: un campo ausente en el payload NO borra lo que ya
    -- había. Una actualización parcial no debe vaciar el perfil.
    set headline                = coalesce(excluded.headline, pp.headline),
        summary                 = coalesce(excluded.summary, pp.summary),
        seniority               = coalesce(excluded.seniority, pp.seniority),
        hourly_rate_usd         = coalesce(excluded.hourly_rate_usd, pp.hourly_rate_usd),
        min_task_budget_usd     = coalesce(excluded.min_task_budget_usd, pp.min_task_budget_usd),
        availability_hours_week = coalesce(excluded.availability_hours_week,
                                           pp.availability_hours_week),
        languages               = case when array_length(excluded.languages, 1) is null
                                       then pp.languages else excluded.languages end,
        timezone                = coalesce(excluded.timezone, pp.timezone),
        is_active               = excluded.is_active,
        accepts_auto_assign     = excluded.accepts_auto_assign,
        updated_at              = now()
  returning pp.id into v_id;

  return v_id;
end;
$function$;

comment on function public.upsert_provider_profile(uuid, jsonb) is
  'Alta o actualización parcial del perfil de proveedor. Respeta RLS (SECURITY INVOKER).';


-- Reemplaza el conjunto de skills del proveedor. Es un `set`, no un `add`: quitar una
-- skill del payload la desvincula, que es la semántica que espera un formulario de perfil.
create or replace function public.set_provider_skills(
  p_provider_profile_id uuid,
  p_skills              jsonb
)
returns integer
language plpgsql
set search_path to 'public', 'extensions', 'pg_temp'
as $function$
declare
  v_count integer := 0;
  v_ids   uuid[];
begin
  if jsonb_typeof(coalesce(p_skills, '[]'::jsonb)) <> 'array' then
    raise exception 'VEKTORA/PROVIDER: p_skills debe ser un arreglo JSON' using errcode = '22023';
  end if;

  select array_agg((s ->> 'skill_id')::uuid)
    into v_ids
  from jsonb_array_elements(p_skills) s
  where s ->> 'skill_id' is not null;

  delete from public.provider_skills ps
   where ps.provider_profile_id = p_provider_profile_id
     and (v_ids is null or not (ps.skill_id = any (v_ids)));

  insert into public.provider_skills (provider_profile_id, skill_id, level, years_experience)
  select
    p_provider_profile_id,
    (s ->> 'skill_id')::uuid,
    coalesce(nullif(s ->> 'level', '')::smallint, 3),
    nullif(s ->> 'years_experience', '')::numeric
  from jsonb_array_elements(coalesce(p_skills, '[]'::jsonb)) s
  where s ->> 'skill_id' is not null
  on conflict (provider_profile_id, skill_id) do update
    set level            = excluded.level,
        years_experience = excluded.years_experience;

  select count(*) into v_count
  from public.provider_skills
  where provider_profile_id = p_provider_profile_id;

  return v_count;
end;
$function$;

comment on function public.set_provider_skills(uuid, jsonb) is
  'Reemplaza el conjunto de skills del proveedor. Respeta RLS (SECURITY INVOKER).';


-- =====================================================================================
-- 06 · RLS Y PRIVILEGIOS
-- =====================================================================================

alter table public.skill_aliases enable row level security;

-- Lectura pública: saber que `reactjs` apunta a `react` no revela nada y hace explicable
-- el comportamiento del matching. Escritura, solo por `resolve_or_create_skill`.
drop policy if exists skill_aliases_select_all on public.skill_aliases;
create policy skill_aliases_select_all on public.skill_aliases
  for select to anon, authenticated using (true);

grant select on public.skill_aliases to anon, authenticated;
grant all    on public.skill_aliases to service_role;

-- Misma trampa de siempre: toda función nueva nace con EXECUTE para PUBLIC, así que hay
-- que revocar de PUBLIC y conceder explícitamente.
revoke all on function public.normalize_skill_slug(text) from public;
grant execute on function public.normalize_skill_slug(text)
  to anon, authenticated, service_role;

revoke all on function public.resolve_or_create_skill(text, text, text, numeric) from public;
grant execute on function public.resolve_or_create_skill(text, text, text, numeric)
  to authenticated, service_role;

revoke all on function public.upsert_provider_profile(uuid, jsonb) from public;
grant execute on function public.upsert_provider_profile(uuid, jsonb)
  to authenticated, service_role;

revoke all on function public.set_provider_skills(uuid, jsonb) from public;
grant execute on function public.set_provider_skills(uuid, jsonb)
  to authenticated, service_role;


-- =====================================================================================
-- FIN — db/migrations/0003_provider_onboarding.sql
--
-- Después de aplicarla, vectorizar el catálogo una vez:
--     npm run skills:embed
-- Sin eso, el paso 3 (semántico) se salta y la resolución degrada a exacta + alias.
-- =====================================================================================
