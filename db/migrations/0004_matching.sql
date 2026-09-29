-- =====================================================================================
-- VEKTORA · FASE 4 — Motor de matching híbrido
-- =====================================================================================
-- Aplicar DESPUÉS de db/migrations/0003_provider_onboarding.sql. Idempotente.
--
-- REPARTO DE RESPONSABILIDADES
-- ---------------------------
-- La base hace lo que SOLO la base puede hacer: la búsqueda aproximada de vecinos sobre
-- `provider_profiles.embedding` con el índice HNSW. Nada más.
--
-- El peso de cada componente, la fórmula del `match_score` y la explicación viven en
-- TypeScript (`lib/matching/scoring.ts`), porque son POLÍTICA: cambian con el producto y
-- hay que poder probarlas exhaustivamente sin base de datos. Enterrar la fórmula en una
-- función SQL la volvería intocable y no testeable.
--
-- Contenido:
--   01 · `match_task_candidates` — recuperación de candidatos (ANN + filtros duros)
--   02 · `apply_task_matches`    — persistencia atómica en `task_applications`
--   03 · `accept_task_application` — adjudicación atómica
--   04 · Privilegios
-- =====================================================================================

set search_path = public, extensions;


-- =====================================================================================
-- 01 · match_task_candidates — recuperación
-- =====================================================================================
-- Devuelve los candidatos con TODO lo que el ranking necesita, sin puntuar nada.
--
-- Dos ramas unidas:
--   A) Vecinos por embedding. El `order by embedding <=> …` con `where embedding is not
--      null` es exactamente la forma que exige el índice HNSW parcial; cualquier otra
--      escritura de la distancia provoca un seq scan de toda la tabla. Se sobre-recupera
--      (`p_limit * 4`) ANTES de aplicar los filtros duros, porque el índice ordena por
--      distancia y no sabe nada de disponibilidad ni de presupuesto.
--   B) Proveedores SIN embedding. Entran igual, con `vector_similarity` nula, para que el
--      ranking determinista pueda considerarlos. Sin esta rama, un proveedor recién dado
--      de alta cuya vectorización falló sería invisible para siempre.
--
-- Filtros DUROS (no son puntuación, son elegibilidad):
--   · perfil activo
--   · `accepts_auto_assign` cuando el matching es automático — consentimiento explícito
--   · el dueño del proyecto no puede ser proveedor de su propia tarea
--   · `min_task_budget_usd` por encima del presupuesto de la tarea: no le interesa
--   · quien ya tiene una candidatura resuelta (aceptada, rechazada o retirada) no vuelve
--     a proponerse; las `pending` sí se refrescan

create or replace function public.match_task_candidates(
  p_task_id             uuid,
  p_limit               integer default 20,
  p_require_auto_assign boolean default true
)
returns table (
  provider_profile_id     uuid,
  user_id                 uuid,
  headline                text,
  seniority               text,
  hourly_rate_usd         numeric,
  min_task_budget_usd     numeric,
  availability_hours_week integer,
  reputation_score        numeric,
  tasks_completed         integer,
  tasks_failed            integer,
  avg_rating              numeric,
  on_time_rate            numeric,
  accepts_auto_assign     boolean,
  vector_similarity       numeric,
  skill_slugs             text[],
  skill_levels            integer[]
)
language plpgsql
stable
set search_path to 'public', 'extensions', 'pg_temp'
as $function$
declare
  v_task_embedding vector(1536);
  v_project_owner  uuid;
  v_budget         numeric;
  v_overfetch      integer := greatest(p_limit * 4, 40);
begin
  select t.embedding, p.owner_id, t.budget
    into v_task_embedding, v_project_owner, v_budget
  from public.project_tasks t
  join public.projects p on p.id = t.project_id
  where t.id = p_task_id;

  if not found then
    raise exception 'VEKTORA/MATCH: la tarea % no existe o no es accesible', p_task_id
      using errcode = '42501';
  end if;

  return query
  with ann as (
    -- Rama A: vecinos más cercanos. Esta forma exacta es la que usa el índice HNSW.
    select
      pp.id                                as pid,
      (1 - (pp.embedding <=> v_task_embedding))::numeric as similarity
    from public.provider_profiles pp
    where pp.embedding is not null
      and v_task_embedding is not null
    order by pp.embedding <=> v_task_embedding
    limit v_overfetch
  ),
  candidates as (
    select pp.id as pid, ann.similarity
    from public.provider_profiles pp
    join ann on ann.pid = pp.id
    union
    -- Rama B: sin embedding, para que el ranking determinista pueda considerarlos.
    select pp.id, null::numeric
    from public.provider_profiles pp
    where pp.embedding is null
  )
  select
    pp.id,
    pp.user_id,
    pp.headline,
    pp.seniority,
    pp.hourly_rate_usd,
    pp.min_task_budget_usd,
    pp.availability_hours_week,
    pp.reputation_score,
    pp.tasks_completed,
    pp.tasks_failed,
    pp.avg_rating,
    pp.on_time_rate,
    pp.accepts_auto_assign,
    c.similarity,
    coalesce(agg.slugs,  '{}'::text[]),
    coalesce(agg.levels, '{}'::integer[])
  from candidates c
  join public.provider_profiles pp on pp.id = c.pid
  left join lateral (
    select
      array_agg(s.slug::text order by s.slug) as slugs,
      array_agg(ps.level::integer order by s.slug) as levels
    from public.provider_skills ps
    join public.skills s on s.id = ps.skill_id
    where ps.provider_profile_id = pp.id
  ) agg on true
  where pp.is_active
    and (not p_require_auto_assign or pp.accepts_auto_assign)
    and pp.user_id <> v_project_owner
    and (v_budget is null
         or pp.min_task_budget_usd is null
         or pp.min_task_budget_usd <= v_budget)
    and not exists (
      select 1 from public.task_applications a
      where a.task_id = p_task_id
        and a.provider_id = pp.user_id
        and a.status in ('accepted', 'rejected', 'withdrawn', 'expired')
    )
  order by c.similarity desc nulls last, pp.reputation_score desc
  limit p_limit;
end;
$function$;

comment on function public.match_task_candidates(uuid, integer, boolean) is
  'Candidatos elegibles para una tarea: ANN sobre el HNSW + filtros duros. No puntúa.';


-- =====================================================================================
-- 02 · apply_task_matches — persistencia atómica
-- =====================================================================================
-- Igual que `apply_project_plan`: supabase-js no tiene transacciones multi-sentencia, y
-- N candidaturas insertadas por separado dejarían un shortlist a medias si algo falla.
--
-- `on conflict (task_id, provider_id) do update` refresca la puntuación de una candidatura
-- pendiente en vez de duplicarla: un replan vuelve a evaluar a los mismos proveedores.
-- Las candidaturas ya resueltas NO se tocan.
--
-- Entrada: [{provider_id, vector_score, skill_score, reputation_score, match_score,
--            match_explanation}, …]

create or replace function public.apply_task_matches(
  p_task_id uuid,
  p_matches jsonb
)
returns jsonb
language plpgsql
set search_path to 'public', 'extensions', 'pg_temp'
as $function$
declare
  v_task     public.project_tasks%rowtype;
  v_inserted integer := 0;
begin
  if jsonb_typeof(coalesce(p_matches, '[]'::jsonb)) <> 'array' then
    raise exception 'VEKTORA/MATCH: p_matches debe ser un arreglo JSON' using errcode = '22023';
  end if;

  select * into v_task from public.project_tasks where id = p_task_id;
  if not found then
    raise exception 'VEKTORA/MATCH: la tarea % no existe o no es accesible', p_task_id
      using errcode = '42501';
  end if;

  if v_task.assignee_id is not null then
    raise exception 'VEKTORA/MATCH: la tarea % ya está asignada', p_task_id
      using errcode = '22023';
  end if;

  insert into public.task_applications as ta (
    task_id, provider_id, status, is_auto_generated,
    vector_score, skill_score, reputation_score, match_score, match_explanation
  )
  select
    p_task_id,
    (m ->> 'provider_id')::uuid,
    'pending',
    true,
    nullif(m ->> 'vector_score', '')::numeric,
    nullif(m ->> 'skill_score', '')::numeric,
    nullif(m ->> 'reputation_score', '')::numeric,
    nullif(m ->> 'match_score', '')::numeric,
    coalesce(m -> 'match_explanation', '{}'::jsonb)
  from jsonb_array_elements(coalesce(p_matches, '[]'::jsonb)) m
  where m ->> 'provider_id' is not null
  on conflict (task_id, provider_id) do update
    set vector_score      = excluded.vector_score,
        skill_score       = excluded.skill_score,
        reputation_score  = excluded.reputation_score,
        match_score       = excluded.match_score,
        match_explanation = excluded.match_explanation,
        is_auto_generated = true,
        updated_at        = now()
    -- Una candidatura ya resuelta no se reabre por un recálculo.
    where ta.status = 'pending';

  get diagnostics v_inserted = row_count;

  -- La tarea pasa a `matching` solo si estaba esperando: no se pisa un estado avanzado.
  if v_inserted > 0 and v_task.status in ('ready', 'open') then
    update public.project_tasks
       set status = 'matching', updated_at = now()
     where id = p_task_id;
  end if;

  return jsonb_build_object(
    'task_id', p_task_id,
    'written', v_inserted,
    'total_applications', (select count(*) from public.task_applications where task_id = p_task_id)
  );
end;
$function$;

comment on function public.apply_task_matches(uuid, jsonb) is
  'Escribe el shortlist en task_applications de forma atómica. No reabre candidaturas resueltas.';


-- =====================================================================================
-- 03 · accept_task_application — adjudicación atómica
-- =====================================================================================
-- Sin esto el DAG no avanza: alguien tiene que pasar de "hay candidatos" a "esta persona
-- lo hace". Tres escrituras que deben ocurrir juntas o ninguna: la candidatura aceptada,
-- el resto rechazadas, y la tarea asignada.
--
-- `for update` sobre la tarea serializa dos adjudicaciones simultáneas: la segunda
-- encuentra `assignee_id` ya puesto y falla en vez de pisar a la primera.

create or replace function public.accept_task_application(
  p_application_id uuid
)
returns jsonb
language plpgsql
set search_path to 'public', 'extensions', 'pg_temp'
as $function$
declare
  v_app  public.task_applications%rowtype;
  v_task public.project_tasks%rowtype;
begin
  select * into v_app from public.task_applications where id = p_application_id;
  if not found then
    raise exception 'VEKTORA/MATCH: la candidatura % no existe o no es accesible', p_application_id
      using errcode = '42501';
  end if;

  select * into v_task from public.project_tasks where id = v_app.task_id for update;
  if not found then
    raise exception 'VEKTORA/MATCH: la tarea de la candidatura no existe' using errcode = '42501';
  end if;

  if v_task.assignee_id is not null then
    raise exception 'VEKTORA/MATCH: la tarea % ya está asignada a %', v_task.id, v_task.assignee_id
      using errcode = '23505';
  end if;

  update public.task_applications
     set status = 'accepted', decided_at = now(), updated_at = now()
   where id = p_application_id;

  update public.task_applications
     set status = 'rejected', decided_at = now(), updated_at = now()
   where task_id = v_app.task_id
     and id <> p_application_id
     and status in ('pending', 'shortlisted');

  update public.project_tasks
     set assignee_id = v_app.provider_id,
         status      = 'assigned',
         assigned_at = now(),
         updated_at  = now()
   where id = v_app.task_id;

  return jsonb_build_object(
    'task_id', v_app.task_id,
    'application_id', p_application_id,
    'provider_id', v_app.provider_id,
    'status', 'assigned'
  );
end;
$function$;

comment on function public.accept_task_application(uuid) is
  'Adjudica la tarea: acepta una candidatura, rechaza el resto y asigna. Todo o nada.';


-- =====================================================================================
-- 03.5 · skill_similarity_pairs — calibración del umbral semántico
-- =====================================================================================
-- Diagnóstico, no runtime. Devuelve la similitud entre pares de skills del catálogo para
-- poder ELEGIR `VEKTORA_SKILL_MATCH_THRESHOLD` y la recalibración del componente vectorial
-- con evidencia en vez de por intuición.
--
-- Hace falta porque los embeddings de `gemini-embedding-001` tienen el rango dinámico
-- comprimido: casi todo cae alto, y un umbral elegido a ojo agrupa de más o de menos sin
-- que se note hasta que el matching empieza a devolver listas vacías o absurdas.
--
-- Los embeddings ya están en la base, así que esto no gasta cuota de la API.

create or replace function public.skill_similarity_pairs(
  p_min   numeric default 0,
  p_limit integer default 200
)
returns table (slug_a text, slug_b text, similarity numeric)
language sql
stable
set search_path to 'public', 'extensions', 'pg_temp'
as $function$
  select
    a.slug::text,
    b.slug::text,
    round((1 - (a.embedding <=> b.embedding))::numeric, 5)
  from public.skills a
  join public.skills b
    -- `a.slug < b.slug` evita el par consigo mismo y los duplicados simétricos.
    on a.slug < b.slug
  where a.embedding is not null
    and b.embedding is not null
    and a.is_active and b.is_active
    and (1 - (a.embedding <=> b.embedding)) >= p_min
  order by 3 desc
  limit p_limit;
$function$;

comment on function public.skill_similarity_pairs(numeric, integer) is
  'Pares de skills con su similitud coseno. Diagnóstico para calibrar umbrales.';


-- =====================================================================================
-- 04 · PRIVILEGIOS
-- =====================================================================================
-- Misma trampa de siempre: toda función nueva nace con EXECUTE para PUBLIC.
--
-- `match_task_candidates` es STABLE y sin SECURITY DEFINER: respeta RLS, así que un
-- usuario autenticado solo obtiene candidatos de una tarea que puede ver.

revoke all on function public.match_task_candidates(uuid, integer, boolean) from public;
grant execute on function public.match_task_candidates(uuid, integer, boolean)
  to authenticated, service_role;

revoke all on function public.apply_task_matches(uuid, jsonb) from public;
grant execute on function public.apply_task_matches(uuid, jsonb) to service_role;

revoke all on function public.accept_task_application(uuid) from public;
grant execute on function public.accept_task_application(uuid)
  to authenticated, service_role;

revoke all on function public.skill_similarity_pairs(numeric, integer) from public;
grant execute on function public.skill_similarity_pairs(numeric, integer)
  to authenticated, service_role;


-- =====================================================================================
-- FIN — db/migrations/0004_matching.sql
-- Verificación: db/verify/03_matching.sql   ·   Uso: npm run match -- <task_id>
-- =====================================================================================
