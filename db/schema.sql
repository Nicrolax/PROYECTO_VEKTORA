-- =====================================================================================
-- VEKTORA · FASE 1 — Modelo de datos
-- =====================================================================================
-- Destino: Supabase (PostgreSQL 16 + pgvector). Ejecutar en el SQL Editor.
--
-- PROCEDENCIA: este archivo NO está deducido de la documentación. Se reconstruyó el
-- 2026-09-14 a partir del volcado de catálogos de la base realmente desplegada
-- (pg_type, information_schema.columns, pg_constraint, pg_indexes, pg_policies,
-- pg_trigger, pg_get_functiondef). Cuerpos de función y políticas son literales.
--
-- ORDEN DE DESPLIEGUE
--   1. db/schema.sql                   <- este archivo
--   2. db/migrations/0002_planner.sql
--   3. db/seeds/01_skills.sql
--
-- IDEMPOTENTE: todo `create` lleva `if not exists`, las funciones son `create or replace`,
-- los triggers y las políticas se eliminan antes de crearse.
--
-- MODELO DE SEGURIDAD
--   · RLS activo en las 14 tablas. Ausencia de política = denegación.
--   · Ninguna política concede INSERT/UPDATE sobre `ai_runs`, `reputation_events` ni
--     `audit_logs`: esas tablas solo las escribe `service_role`, que bypassea RLS. Es la
--     identidad de los agentes autónomos.
--   · Los helpers son SECURITY DEFINER para evitar recursión de políticas.
-- =====================================================================================


-- =====================================================================================
-- 00 · EXTENSIONES
-- =====================================================================================

create schema if not exists extensions;

create extension if not exists "uuid-ossp" with schema extensions;
create extension if not exists "vector"    with schema extensions;
create extension if not exists "citext"    with schema extensions;

set search_path = public, extensions;


-- =====================================================================================
-- 01 · TIPOS ENUM DEL DOMINIO (14)
-- =====================================================================================
-- `create type` no admite `if not exists`: cada uno va en un bloque que ignora
-- `duplicate_object`. Eso es lo que hace el archivo reaplicable.

do $$ begin
  create type user_role as enum ('client', 'provider', 'both', 'admin');
exception when duplicate_object then null; end $$;

do $$ begin
  create type account_status as enum ('active', 'suspended', 'banned', 'deleted');
exception when duplicate_object then null; end $$;

-- Quién ejecuta una acción. `ai_agent` es un actor de primera clase: el sistema es
-- autónomo y la mayoría de las escrituras no vienen de una persona.
do $$ begin
  create type actor_type as enum ('user', 'ai_agent', 'system', 'service');
exception when duplicate_object then null; end $$;

do $$ begin
  create type project_status as enum
    ('draft', 'planning', 'planned', 'active', 'paused', 'completed', 'cancelled', 'failed');
exception when duplicate_object then null; end $$;

do $$ begin
  create type project_visibility as enum ('private', 'public');
exception when duplicate_object then null; end $$;

do $$ begin
  create type task_status as enum (
    'blocked', 'ready', 'open', 'matching', 'assigned', 'in_progress',
    'submitted', 'in_review', 'revision_requested', 'approved', 'cancelled', 'failed'
  );
exception when duplicate_object then null; end $$;

-- Semántica de la arista del DAG. El planificador solo emite `finish_to_start`; los otros
-- tres quedan disponibles para planificación temporal fina.
do $$ begin
  create type dependency_type as enum
    ('finish_to_start', 'start_to_start', 'finish_to_finish', 'start_to_finish');
exception when duplicate_object then null; end $$;

do $$ begin
  create type application_status as enum
    ('pending', 'shortlisted', 'accepted', 'rejected', 'withdrawn', 'expired');
exception when duplicate_object then null; end $$;

do $$ begin
  create type qa_status as enum
    ('pending', 'running', 'approved', 'rejected', 'revision_requested', 'error');
exception when duplicate_object then null; end $$;

do $$ begin
  create type review_source as enum ('human', 'ai_judge', 'system');
exception when duplicate_object then null; end $$;

do $$ begin
  create type reputation_event_type as enum (
    'onboarding_bonus', 'deliverable_approved', 'deliverable_rejected',
    'task_completed', 'task_failed', 'review_received', 'deadline_met',
    'deadline_missed', 'evidence_verified', 'evidence_disputed', 'manual_adjustment'
  );
exception when duplicate_object then null; end $$;

-- ATENCIÓN: estos tres ENUM están replicados como literales en lib/ai/types.ts.
-- Añadir una etiqueta aquí obliga a añadirla allí, o la telemetría fallará al insertar
-- con "invalid input value for enum".
do $$ begin
  create type ai_provider as enum ('groq', 'google', 'other');
exception when duplicate_object then null; end $$;

do $$ begin
  create type ai_operation as enum (
    'project_planning', 'task_decomposition', 'embedding', 'matching',
    'qa_judge', 'schema_repair', 'summarization', 'other'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type ai_run_status as enum (
    'pending', 'success', 'invalid_output', 'repaired', 'failed', 'timeout', 'rate_limited'
  );
exception when duplicate_object then null; end $$;


-- =====================================================================================
-- 02 · UTILIDADES COMUNES
-- =====================================================================================

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $function$
begin
  new.updated_at := now();
  return new;
end;
$function$;

-- `reputation_events` y `audit_logs` son el libro mayor del sistema: si se pudieran editar,
-- la reputación dejaría de ser reconstruible y perdería su valor como mecanismo de confianza.
create or replace function public.forbid_mutation()
returns trigger
language plpgsql
as $function$
begin
  raise exception 'VEKTORA/SEC: la tabla % es append-only (operación % rechazada)',
    tg_table_name, tg_op
    using errcode = '42501';
end;
$function$;


-- =====================================================================================
-- 03 · TABLAS (14)
-- =====================================================================================

-- --- 03.1 Identidad -------------------------------------------------------------------
-- `public.users` es la proyección de `auth.users`. El resto del esquema referencia ESTA
-- tabla y nunca `auth.users` directamente.
create table if not exists public.users (
  id            uuid primary key default uuid_generate_v4()
                  references auth.users (id) on delete cascade,
  email         citext,
  role          user_role      not null default 'both',
  status        account_status not null default 'active',
  -- Un agente autónomo también es una cuenta: puede ser dueño de proyectos y recibir
  -- reputación. Este flag lo distingue de una persona.
  is_agent      boolean not null default false,
  last_seen_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- El nombre y los datos de presentación viven aquí, NO en `users`: `users` es identidad y
-- autorización, `profiles` es contenido editable por la persona.
create table if not exists public.profiles (
  id           uuid primary key default uuid_generate_v4(),
  user_id      uuid not null unique references public.users (id) on delete cascade,
  full_name    text,
  display_name text,
  avatar_url   text,
  bio          text,
  country_code char(2),
  timezone     text  not null default 'UTC',
  locale       text  not null default 'es',
  website_url  text,
  links        jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint profiles_bio_len check (bio is null or char_length(bio) <= 4000)
);

-- Perfil de ejecución. `reputation_score`, `tasks_completed`, `tasks_failed` y `avg_rating`
-- son PROYECCIONES materializadas por trigger desde `reputation_events` y `reviews`.
create table if not exists public.provider_profiles (
  id                      uuid primary key default uuid_generate_v4(),
  user_id                 uuid not null unique references public.users (id) on delete cascade,
  headline                text,
  summary                 text,
  seniority               text,
  hourly_rate_usd         numeric(10, 2),
  min_task_budget_usd     numeric(12, 2),
  availability_hours_week integer,
  languages               text[] not null default '{}'::text[],
  timezone                text,
  is_active               boolean not null default true,
  -- Consentimiento explícito a la asignación automática: sin esto, un sistema sin humanos
  -- estaría adjudicando trabajo a quien no lo pidió.
  accepts_auto_assign     boolean not null default true,
  reputation_score        numeric(8, 3) not null default 0,
  tasks_completed         integer not null default 0,
  tasks_failed            integer not null default 0,
  avg_rating              numeric(4, 2),
  on_time_rate            numeric(5, 4),
  -- 1536 dimensiones: gemini-embedding-001 recortado por MRL y renormalizado L2.
  -- Cambiar el tamaño obliga a cambiar AI_EMBEDDING_DIMENSIONS y a reconstruir el HNSW.
  embedding               vector(1536),
  embedding_model         text,
  embedding_updated_at    timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  constraint provider_hourly_rate_pos
    check (hourly_rate_usd is null or hourly_rate_usd >= 0),
  constraint provider_avail_range
    check (availability_hours_week is null
           or (availability_hours_week >= 0 and availability_hours_week <= 168)),
  constraint provider_avg_rating_range
    check (avg_rating is null or (avg_rating >= 0 and avg_rating <= 5)),
  constraint provider_on_time_range
    check (on_time_rate is null or (on_time_rate >= 0 and on_time_rate <= 1))
);

-- --- 03.2 Catálogo de skills ----------------------------------------------------------
-- `slug` es citext: el planificador normaliza a minúsculas, pero un slug con mayúsculas
-- no debe duplicar la fila.
create table if not exists public.skills (
  id          uuid primary key default uuid_generate_v4(),
  slug        citext not null unique,
  name        text   not null,
  category    text,
  description text,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);

create table if not exists public.provider_skills (
  id                  uuid primary key default uuid_generate_v4(),
  provider_profile_id uuid not null references public.provider_profiles (id) on delete cascade,
  skill_id            uuid not null references public.skills (id) on delete cascade,
  level               smallint not null default 3,
  years_experience    numeric(4, 1),
  is_verified         boolean not null default false,
  created_at          timestamptz not null default now(),
  constraint provider_skills_unique unique (provider_profile_id, skill_id),
  constraint provider_skills_level_range check (level >= 1 and level <= 5),
  constraint provider_skills_years_pos
    check (years_experience is null or years_experience >= 0)
);

-- --- 03.3 Proyectos y tareas ----------------------------------------------------------
create table if not exists public.projects (
  id                uuid primary key default uuid_generate_v4(),
  owner_id          uuid not null references public.users (id) on delete cascade,
  title             text not null,
  objective         text not null,
  description       text,
  status            project_status     not null default 'draft',
  visibility        project_visibility not null default 'private',
  currency          char(3) not null default 'USD',
  budget_total      numeric(14, 2),
  deadline          timestamptz,
  acceptance_policy jsonb not null default '{}'::jsonb,
  -- Traza del ProjectPlanner: versión, resumen, estadísticas del DAG y CORRECCIONES
  -- automáticas aplicadas. Es el registro de auditoría de un sistema sin humanos.
  planner_metadata  jsonb not null default '{}'::jsonb,
  dag_generated_at  timestamptz,
  started_at        timestamptz,
  completed_at      timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint projects_title_len
    check (char_length(title) >= 3 and char_length(title) <= 200),
  constraint projects_objective_len
    check (char_length(objective) >= 10 and char_length(objective) <= 8000),
  constraint projects_budget_pos check (budget_total is null or budget_total >= 0)
);

create table if not exists public.project_tasks (
  id                   uuid primary key default uuid_generate_v4(),
  project_id           uuid not null references public.projects (id) on delete cascade,
  parent_task_id       uuid references public.project_tasks (id) on delete set null,
  code                 text not null,
  title                text not null,
  description          text,
  acceptance_criteria  jsonb  not null default '[]'::jsonb,
  required_skills      text[] not null default '{}'::text[],
  status               task_status not null default 'blocked',
  priority             smallint not null default 3,
  order_index          integer  not null default 0,
  depth                smallint not null default 0,
  estimated_hours      numeric(8, 2),
  budget               numeric(12, 2),
  assignee_id          uuid references public.users (id) on delete set null,
  assigned_at          timestamptz,
  due_at               timestamptz,
  started_at           timestamptz,
  completed_at         timestamptz,
  embedding            vector(1536),
  embedding_model      text,
  embedding_updated_at timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  -- El código identifica la tarea dentro del proyecto: es la clave que usa el planificador.
  constraint project_tasks_code_unique unique (project_id, code),
  constraint project_tasks_title_len
    check (char_length(title) >= 3 and char_length(title) <= 300),
  constraint project_tasks_priority_range check (priority >= 1 and priority <= 5),
  constraint project_tasks_hours_pos
    check (estimated_hours is null or estimated_hours >= 0),
  constraint project_tasks_budget_pos check (budget is null or budget >= 0),
  constraint project_tasks_criteria_is_array
    check (jsonb_typeof(acceptance_criteria) = 'array'),
  constraint project_tasks_no_self_parent
    check (parent_task_id is null or parent_task_id <> id)
);

-- Aristas del DAG: `task_id` NO puede empezar hasta que `depends_on_task_id` se satisfaga.
-- No hay `project_id` aquí: la pertenencia se deriva de `project_tasks` y el trigger
-- `prevent_dag_cycles` comprueba que ambos extremos sean del mismo proyecto.
create table if not exists public.task_dependencies (
  id                 uuid primary key default uuid_generate_v4(),
  task_id            uuid not null references public.project_tasks (id) on delete cascade,
  depends_on_task_id uuid not null references public.project_tasks (id) on delete cascade,
  dependency_type    dependency_type not null default 'finish_to_start',
  lag_hours          numeric(8, 2) not null default 0,
  created_by         actor_type not null default 'ai_agent',
  created_at         timestamptz not null default now(),
  constraint task_dependencies_unique unique (task_id, depends_on_task_id),
  constraint task_dependencies_no_self check (task_id <> depends_on_task_id)
);

-- --- 03.4 Observabilidad de la IA -----------------------------------------------------
-- Contrato con lib/ai/telemetry.ts: `start()` inserta en `pending` y `finish()` cierra la
-- fila. Una corrida colgada queda como `pending` con `finished_at` nulo — esa es
-- exactamente la señal que quiere la FASE 7.
create table if not exists public.ai_runs (
  id                uuid primary key default uuid_generate_v4(),
  operation         ai_operation  not null,
  provider          ai_provider   not null,
  model             text          not null,
  status            ai_run_status not null default 'pending',
  attempt           smallint      not null default 1,
  -- Proveedor cuyo turno se agotó antes de este intento: hace visible la cadena de
  -- fallback en una consulta simple.
  fell_back_from    ai_provider,
  parent_run_id     uuid references public.ai_runs (id) on delete set null,
  user_id           uuid references public.users (id) on delete set null,
  project_id        uuid references public.projects (id) on delete set null,
  task_id           uuid references public.project_tasks (id) on delete set null,
  prompt_tokens     integer,
  completion_tokens integer,
  total_tokens      integer,
  latency_ms        integer,
  cost_usd          numeric(12, 6) not null default 0,
  request_payload   jsonb not null default '{}'::jsonb,
  response_payload  jsonb not null default '{}'::jsonb,
  zod_errors        jsonb,
  error_message     text,
  started_at        timestamptz not null default now(),
  finished_at       timestamptz,
  constraint ai_runs_attempt_pos check (attempt >= 1),
  constraint ai_runs_tokens_pos
    check (coalesce(prompt_tokens, 0) >= 0 and coalesce(completion_tokens, 0) >= 0),
  constraint ai_runs_no_self_parent check (parent_run_id is null or parent_run_id <> id)
);

-- --- 03.5 Asignación, entrega y revisión ----------------------------------------------
create table if not exists public.task_applications (
  id                uuid primary key default uuid_generate_v4(),
  task_id           uuid not null references public.project_tasks (id) on delete cascade,
  provider_id       uuid not null references public.users (id) on delete cascade,
  cover_letter      text,
  proposed_price    numeric(12, 2),
  proposed_hours    numeric(8, 2),
  status            application_status not null default 'pending',
  -- Desglose del matching híbrido de la FASE 4. Se guarda cada componente y no solo el
  -- total: sin ellos no se puede explicar ni auditar una asignación automática.
  vector_score      numeric(6, 5),
  skill_score       numeric(6, 5),
  reputation_score  numeric(6, 5),
  match_score       numeric(6, 5),
  match_explanation jsonb not null default '{}'::jsonb,
  is_auto_generated boolean not null default false,
  decided_at        timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint task_applications_unique unique (task_id, provider_id),
  constraint task_applications_price_pos
    check (proposed_price is null or proposed_price >= 0),
  constraint task_applications_vector_range
    check (vector_score is null or (vector_score >= 0 and vector_score <= 1)),
  constraint task_applications_skill_range
    check (skill_score is null or (skill_score >= 0 and skill_score <= 1)),
  constraint task_applications_reputation_range
    check (reputation_score is null or (reputation_score >= 0 and reputation_score <= 1)),
  constraint task_applications_match_range
    check (match_score is null or (match_score >= 0 and match_score <= 1))
);

-- `version` se asigna sola (`set_deliverable_version`): basta insertar sin ella.
-- `evidence` es lo que evalúa el AI Judge de la FASE 5; `qa_*` guarda su veredicto.
create table if not exists public.deliverables (
  id                  uuid primary key default uuid_generate_v4(),
  task_id             uuid not null references public.project_tasks (id) on delete cascade,
  provider_id         uuid not null references public.users (id) on delete cascade,
  version             integer not null default 1,
  summary             text,
  content             text,
  artifacts           jsonb not null default '[]'::jsonb,
  evidence            jsonb not null default '{}'::jsonb,
  qa_status           qa_status not null default 'pending',
  qa_score            numeric(5, 2),
  qa_feedback         jsonb not null default '{}'::jsonb,
  qa_criteria_results jsonb not null default '[]'::jsonb,
  -- Corrida del AI Judge que emitió el veredicto sobre este entregable.
  qa_run_id           uuid references public.ai_runs (id) on delete set null,
  qa_evaluated_at     timestamptz,
  submitted_at        timestamptz not null default now(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint deliverables_version_unique unique (task_id, version),
  constraint deliverables_version_pos check (version >= 1),
  constraint deliverables_artifacts_is_array check (jsonb_typeof(artifacts) = 'array'),
  constraint deliverables_qa_score_range
    check (qa_score is null or (qa_score >= 0 and qa_score <= 100))
);

create table if not exists public.reviews (
  id                  uuid primary key default uuid_generate_v4(),
  task_id             uuid not null references public.project_tasks (id) on delete cascade,
  deliverable_id      uuid references public.deliverables (id) on delete set null,
  reviewer_id         uuid references public.users (id) on delete set null,
  reviewee_id         uuid not null references public.users (id) on delete cascade,
  source              review_source not null default 'ai_judge',
  rating              numeric(3, 2) not null,
  quality_score       numeric(3, 2),
  communication_score numeric(3, 2),
  timeliness_score    numeric(3, 2),
  comment             text,
  is_public           boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint reviews_rating_range check (rating >= 0 and rating <= 5),
  constraint reviews_quality_range
    check (quality_score is null or (quality_score >= 0 and quality_score <= 5)),
  constraint reviews_comm_range
    check (communication_score is null or (communication_score >= 0 and communication_score <= 5)),
  constraint reviews_time_range
    check (timeliness_score is null or (timeliness_score >= 0 and timeliness_score <= 5)),
  -- Una reseña humana necesita firmante; la del AI Judge no tiene `reviewer_id`.
  constraint reviews_human_has_reviewer
    check (source <> 'human' or reviewer_id is not null),
  constraint reviews_no_self check (reviewer_id is null or reviewer_id <> reviewee_id)
);

-- Libro mayor de reputación: APPEND-ONLY. Cualquier puntuación mostrada debe poder
-- reconstruirse sumando estos eventos (delta * weight).
create table if not exists public.reputation_events (
  id             uuid primary key default uuid_generate_v4(),
  user_id        uuid not null references public.users (id) on delete cascade,
  event_type     reputation_event_type not null,
  delta          numeric(8, 3) not null,
  weight         numeric(6, 3) not null default 1,
  reason         text,
  task_id        uuid references public.project_tasks (id) on delete set null,
  deliverable_id uuid references public.deliverables (id) on delete set null,
  review_id      uuid references public.reviews (id) on delete set null,
  actor_type     actor_type not null default 'ai_agent',
  metadata       jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now(),
  constraint reputation_events_delta_range check (delta >= -100 and delta <= 100)
);

-- --- 03.6 Auditoría --------------------------------------------------------------------
create table if not exists public.audit_logs (
  id          uuid primary key default uuid_generate_v4(),
  actor_id    uuid references public.users (id) on delete set null,
  actor_type  actor_type not null default 'user',
  action      text not null,
  entity_type text not null,
  entity_id   uuid,
  project_id  uuid references public.projects (id) on delete set null,
  changes     jsonb not null default '{}'::jsonb,
  metadata    jsonb not null default '{}'::jsonb,
  ip_address  inet,
  user_agent  text,
  created_at  timestamptz not null default now()
);


-- =====================================================================================
-- 04 · INTEGRIDAD DEL GRAFO
-- =====================================================================================

-- Valida, en este orden: auto-dependencia, pertenencia al MISMO proyecto y aciclicidad.
--
-- Es SECURITY DEFINER a propósito: con RLS activo, un recorrido con los privilegios del
-- invocante vería solo un subgrafo y podría declarar acíclico un grafo que no lo es.
--
-- Lanza SQLSTATE 23514 con la ruta del ciclo. El ProjectPlanner de la FASE 3 lo captura,
-- rompe el ciclo y reintenta UNA vez.
create or replace function public.prevent_dag_cycles()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_task_project      uuid;
  v_depends_project   uuid;
  v_cycle_path        uuid[];
  v_old_edge_id       uuid;
begin
  -- En UPDATE, la arista vieja debe ignorarse: será reemplazada por la nueva.
  -- OLD solo se toca dentro de esta guarda para no depender del comportamiento
  -- de OLD en triggers de INSERT.
  if tg_op = 'UPDATE' then
    v_old_edge_id := old.id;
  end if;

  -- 1) Auto-dependencia
  if new.task_id = new.depends_on_task_id then
    raise exception
      'VEKTORA/DAG: una tarea no puede depender de sí misma (task_id=%)', new.task_id
      using errcode = '23514';
  end if;

  -- 2) Coherencia de proyecto
  select project_id into v_task_project
  from public.project_tasks where id = new.task_id;

  select project_id into v_depends_project
  from public.project_tasks where id = new.depends_on_task_id;

  if v_task_project is null or v_depends_project is null then
    raise exception
      'VEKTORA/DAG: tarea inexistente (task_id=%, depends_on_task_id=%)',
      new.task_id, new.depends_on_task_id
      using errcode = '23503';
  end if;

  if v_task_project <> v_depends_project then
    raise exception
      'VEKTORA/DAG: las dependencias deben pertenecer al mismo proyecto (% <> %)',
      v_task_project, v_depends_project
      using errcode = '23514';
  end if;

  -- 3) Detección de ciclo
  -- Se recorre la cadena de dependencias existente partiendo de depends_on_task_id.
  -- Si en ese recorrido aparece task_id, la arista candidata cerraría el ciclo.
  -- `path` NO incluye task_id: así el nodo objetivo es alcanzable una única vez, y el
  -- filtro anti-repetición sigue garantizando terminación ante ciclos preexistentes.
  with recursive upstream as (
    select
      new.depends_on_task_id            as node,
      array[new.depends_on_task_id]     as path
    union all
    select
      d.depends_on_task_id,
      u.path || d.depends_on_task_id
    from public.task_dependencies d
    join upstream u on d.task_id = u.node
    where not d.depends_on_task_id = any (u.path)   -- corta ciclos preexistentes
      and array_length(u.path, 1) < 1000            -- cota dura de seguridad
      and (v_old_edge_id is null or d.id <> v_old_edge_id)
  )
  select array[new.task_id] || u.path into v_cycle_path
  from upstream u
  where u.node = new.task_id
  limit 1;

  if v_cycle_path is not null then
    raise exception
      'VEKTORA/DAG: la dependencia % -> % cierra un ciclo. Ruta detectada: %',
      new.task_id, new.depends_on_task_id, v_cycle_path
      using errcode = '23514',
            hint = 'Elimine una arista intermedia o replanifique el subgrafo afectado.';
  end if;

  return new;
end;
$function$;

drop trigger if exists trg_prevent_dag_cycles on public.task_dependencies;
create trigger trg_prevent_dag_cycles
  before insert or update of task_id, depends_on_task_id on public.task_dependencies
  for each row execute function public.prevent_dag_cycles();

-- La jerarquía `parent_task_id` es un árbol aparte del DAG de dependencias, y también
-- puede ciclar. Se recorre iterativamente con cota dura.
create or replace function public.prevent_task_parent_cycles()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_node  uuid := new.parent_task_id;
  v_depth integer := 0;
begin
  if new.parent_task_id is null then
    return new;
  end if;

  if new.parent_task_id = new.id then
    raise exception 'VEKTORA/DAG: una tarea no puede ser su propio padre (id=%)', new.id
      using errcode = '23514';
  end if;

  while v_node is not null and v_depth < 1000 loop
    if v_node = new.id then
      raise exception
        'VEKTORA/DAG: el reparentado de la tarea % cierra un ciclo jerárquico', new.id
        using errcode = '23514';
    end if;
    select parent_task_id into v_node from public.project_tasks where id = v_node;
    v_depth := v_depth + 1;
  end loop;

  return new;
end;
$function$;

drop trigger if exists trg_prevent_task_parent_cycles on public.project_tasks;
create trigger trg_prevent_task_parent_cycles
  before insert or update of parent_task_id on public.project_tasks
  for each row execute function public.prevent_task_parent_cycles();


-- =====================================================================================
-- 05 · TRIGGERS DE INTEGRIDAD Y AUTOMATIZACIÓN
-- =====================================================================================

-- --- 05.1 updated_at ------------------------------------------------------------------
do $$
declare
  v_table text;
begin
  foreach v_table in array array[
    'users', 'profiles', 'provider_profiles', 'projects', 'project_tasks',
    'task_applications', 'deliverables', 'reviews'
  ] loop
    execute format('drop trigger if exists trg_%1$s_updated_at on public.%1$I', v_table);
    execute format(
      'create trigger trg_%1$s_updated_at before update on public.%1$I
         for each row execute function public.set_updated_at()',
      v_table
    );
  end loop;
end $$;

-- --- 05.2 Tablas append-only ------------------------------------------------------------
drop trigger if exists trg_reputation_events_immutable on public.reputation_events;
create trigger trg_reputation_events_immutable
  before delete or update on public.reputation_events
  for each row execute function public.forbid_mutation();

drop trigger if exists trg_audit_logs_immutable on public.audit_logs;
create trigger trg_audit_logs_immutable
  before delete or update on public.audit_logs
  for each row execute function public.forbid_mutation();

-- --- 05.3 Versionado automático de entregables -------------------------------------------
create or replace function public.set_deliverable_version()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if new.version is null or new.version <= 1 then
    select coalesce(max(d.version), 0) + 1 into new.version
    from public.deliverables d
    where d.task_id = new.task_id;
  end if;
  return new;
end;
$function$;

drop trigger if exists trg_deliverables_version on public.deliverables;
create trigger trg_deliverables_version
  before insert on public.deliverables
  for each row execute function public.set_deliverable_version();

-- --- 05.4 Escritura restringida por columna -----------------------------------------------
-- RLS es por FILA, no por columna: sin esto, un usuario con permiso legítimo de UPDATE
-- sobre su propia fila de `users` podría ponerse `role = 'admin'`.
create or replace function public.enforce_user_self_update_scope()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  -- auth.uid() es null para service_role/agentes internos: esos sí pueden cambiar el rol.
  if auth.uid() is null or public.is_admin() then
    return new;
  end if;

  if new.role is distinct from old.role then
    raise exception 'VEKTORA/SEC: el rol de la cuenta no puede modificarse por el propio usuario'
      using errcode = '42501';
  end if;

  if new.status is distinct from old.status then
    raise exception 'VEKTORA/SEC: el estado de la cuenta no puede modificarse por el propio usuario'
      using errcode = '42501';
  end if;

  if new.is_agent is distinct from old.is_agent then
    raise exception 'VEKTORA/SEC: el flag is_agent es de administración'
      using errcode = '42501';
  end if;

  new.id := old.id;
  return new;
end;
$function$;

drop trigger if exists trg_users_self_update_scope on public.users;
create trigger trg_users_self_update_scope
  before update on public.users
  for each row execute function public.enforce_user_self_update_scope();

-- El proveedor asignado solo mueve el avance de SU tarea: ni el alcance, ni el
-- presupuesto, ni a quién está asignada.
create or replace function public.enforce_task_assignee_scope()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if auth.uid() is null then
    return new;  -- agentes autónomos / service_role
  end if;

  -- Dueño del proyecto y admin tienen control total.
  if public.is_admin() or exists (
    select 1 from public.projects p where p.id = old.project_id and p.owner_id = auth.uid()
  ) then
    return new;
  end if;

  if old.assignee_id is distinct from auth.uid() then
    raise exception 'VEKTORA/SEC: sin permiso para modificar la tarea %', old.id
      using errcode = '42501';
  end if;

  -- Campos inmutables para el asignado.
  if (new.project_id, new.code, new.title, new.description, new.acceptance_criteria,
      new.required_skills, new.budget, new.assignee_id, new.due_at, new.priority,
      new.parent_task_id, new.order_index)
     is distinct from
     (old.project_id, old.code, old.title, old.description, old.acceptance_criteria,
      old.required_skills, old.budget, old.assignee_id, old.due_at, old.priority,
      old.parent_task_id, old.order_index)
  then
    raise exception
      'VEKTORA/SEC: el proveedor asignado solo puede actualizar status, started_at y completed_at'
      using errcode = '42501';
  end if;

  if new.status not in ('in_progress', 'submitted', 'assigned') then
    raise exception 'VEKTORA/SEC: transición de estado % no permitida al proveedor', new.status
      using errcode = '42501';
  end if;

  return new;
end;
$function$;

drop trigger if exists trg_task_assignee_scope on public.project_tasks;
create trigger trg_task_assignee_scope
  before update on public.project_tasks
  for each row execute function public.enforce_task_assignee_scope();

-- --- 05.5 Proyección de reputación --------------------------------------------------------
-- `provider_profiles.reputation_score` / `tasks_completed` / `tasks_failed` se derivan del
-- libro mayor. `greatest(0, …)` evita que la reputación se vuelva negativa.
create or replace function public.apply_reputation_event()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  update public.provider_profiles pp
     set reputation_score = greatest(0, pp.reputation_score + (new.delta * new.weight)),
         tasks_completed  = pp.tasks_completed
                            + case when new.event_type = 'task_completed' then 1 else 0 end,
         tasks_failed     = pp.tasks_failed
                            + case when new.event_type = 'task_failed' then 1 else 0 end,
         updated_at       = now()
   where pp.user_id = new.user_id;

  return new;
end;
$function$;

drop trigger if exists trg_apply_reputation_event on public.reputation_events;
create trigger trg_apply_reputation_event
  after insert on public.reputation_events
  for each row execute function public.apply_reputation_event();

create or replace function public.refresh_provider_rating()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_user uuid;
begin
  if tg_op = 'DELETE' then
    v_user := old.reviewee_id;
  else
    v_user := new.reviewee_id;
  end if;

  update public.provider_profiles pp
     set avg_rating = sub.avg_rating,
         updated_at = now()
    from (
      select round(avg(r.rating)::numeric, 2) as avg_rating
      from public.reviews r
      where r.reviewee_id = v_user
    ) sub
   where pp.user_id = v_user;

  return null;
end;
$function$;

drop trigger if exists trg_refresh_provider_rating on public.reviews;
create trigger trg_refresh_provider_rating
  after insert or delete or update of rating on public.reviews
  for each row execute function public.refresh_provider_rating();


-- =====================================================================================
-- 06 · BOOTSTRAP DE CUENTAS (auth.users -> public.users + profiles)
-- =====================================================================================
-- Sin esto, `projects.owner_id` nunca tendría a quién apuntar: `auth.users` la escribe
-- GoTrue, no la aplicación.

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  insert into public.users (id, email, role)
  values (
    new.id,
    new.email,
    coalesce((new.raw_user_meta_data ->> 'role')::public.user_role, 'both')
  )
  on conflict (id) do nothing;

  insert into public.profiles (user_id, full_name, avatar_url)
  values (
    new.id,
    new.raw_user_meta_data ->> 'full_name',
    new.raw_user_meta_data ->> 'avatar_url'
  )
  on conflict (user_id) do nothing;

  return new;
end;
$function$;

do $$
begin
  drop trigger if exists trg_auth_user_created on auth.users;
  create trigger trg_auth_user_created
    after insert on auth.users
    for each row execute function public.handle_new_auth_user();
exception
  when insufficient_privilege then
    raise notice
      'VEKTORA: sin privilegio para crear el trigger sobre auth.users; créalo desde el '
      'dashboard de Supabase o ejecuta este bloque como superusuario';
end $$;


-- =====================================================================================
-- 07 · ÍNDICES
-- =====================================================================================
-- PostgreSQL NO indexa las claves foráneas automáticamente: sin estos índices, cada
-- `delete` en cascada hace un seq scan de la tabla hija.

-- --- 07.1 Identidad y catálogo ----------------------------------------------------------
-- Único parcial: `users.email` es nullable (una cuenta de agente puede no tener correo),
-- y un UNIQUE normal permitiría un solo NULL en algunos motores. Parcial es explícito.
create unique index if not exists idx_users_email
  on public.users (email) where email is not null;
create index if not exists idx_users_role    on public.users (role);
create index if not exists idx_users_status  on public.users (status);
create index if not exists idx_profiles_country on public.profiles (country_code);
create index if not exists idx_skills_category  on public.skills (category) where is_active;

-- --- 07.2 Proveedores ---------------------------------------------------------------------
create index if not exists idx_provider_profiles_active_reputation
  on public.provider_profiles (is_active, reputation_score desc);
create index if not exists idx_provider_profiles_rate
  on public.provider_profiles (hourly_rate_usd) where is_active;
create index if not exists idx_provider_profiles_languages
  on public.provider_profiles using gin (languages);
create index if not exists idx_provider_skills_provider
  on public.provider_skills (provider_profile_id);
create index if not exists idx_provider_skills_skill
  on public.provider_skills (skill_id);

-- --- 07.3 Proyectos y tareas --------------------------------------------------------------
create index if not exists idx_projects_owner  on public.projects (owner_id);
create index if not exists idx_projects_status on public.projects (status);
create index if not exists idx_projects_deadline
  on public.projects (deadline) where deadline is not null;
create index if not exists idx_projects_visibility_status
  on public.projects (visibility, status) where visibility = 'public';

create index if not exists idx_project_tasks_project on public.project_tasks (project_id);
create index if not exists idx_project_tasks_status  on public.project_tasks (status);
create index if not exists idx_project_tasks_project_status_order
  on public.project_tasks (project_id, status, order_index);
create index if not exists idx_project_tasks_parent
  on public.project_tasks (parent_task_id) where parent_task_id is not null;
create index if not exists idx_project_tasks_assignee
  on public.project_tasks (assignee_id) where assignee_id is not null;
create index if not exists idx_project_tasks_due_at
  on public.project_tasks (due_at) where due_at is not null;
-- Cola de trabajo del motor de matching (FASE 4): una fracción diminuta de la tabla.
create index if not exists idx_project_tasks_open_queue
  on public.project_tasks (created_at)
  where status in ('ready', 'open', 'matching');
create index if not exists idx_project_tasks_required_skills
  on public.project_tasks using gin (required_skills);

create index if not exists idx_task_dependencies_task
  on public.task_dependencies (task_id);
create index if not exists idx_task_dependencies_depends_on
  on public.task_dependencies (depends_on_task_id);

-- --- 07.4 Asignación, entrega y revisión ----------------------------------------------------
create index if not exists idx_task_applications_task     on public.task_applications (task_id);
create index if not exists idx_task_applications_provider on public.task_applications (provider_id);
create index if not exists idx_task_applications_status   on public.task_applications (status);
create index if not exists idx_task_applications_ranking
  on public.task_applications (task_id, match_score desc nulls last);

create index if not exists idx_deliverables_task      on public.deliverables (task_id);
create index if not exists idx_deliverables_provider  on public.deliverables (provider_id);
create index if not exists idx_deliverables_qa_status on public.deliverables (qa_status);
create index if not exists idx_deliverables_qa_run
  on public.deliverables (qa_run_id) where qa_run_id is not null;
-- Cola del AI Judge (FASE 5), en orden de llegada.
create index if not exists idx_deliverables_qa_queue
  on public.deliverables (submitted_at) where qa_status in ('pending', 'running');

create index if not exists idx_reviews_task    on public.reviews (task_id);
create index if not exists idx_reviews_reviewee on public.reviews (reviewee_id);
create index if not exists idx_reviews_reviewer
  on public.reviews (reviewer_id) where reviewer_id is not null;
create index if not exists idx_reviews_deliverable
  on public.reviews (deliverable_id) where deliverable_id is not null;
-- Una persona reseña una vez por tarea; el AI Judge una vez por (tarea, evaluado, fuente).
create unique index if not exists reviews_unique_human
  on public.reviews (task_id, reviewer_id, reviewee_id) where reviewer_id is not null;
create unique index if not exists reviews_unique_machine
  on public.reviews (task_id, reviewee_id, source) where reviewer_id is null;

create index if not exists idx_reputation_events_user
  on public.reputation_events (user_id, created_at desc);
create index if not exists idx_reputation_events_type
  on public.reputation_events (event_type);
create index if not exists idx_reputation_events_task
  on public.reputation_events (task_id) where task_id is not null;
create index if not exists idx_reputation_events_deliverable
  on public.reputation_events (deliverable_id) where deliverable_id is not null;
create index if not exists idx_reputation_events_review
  on public.reputation_events (review_id) where review_id is not null;

-- --- 07.5 Observabilidad --------------------------------------------------------------------
create index if not exists idx_ai_runs_operation_status
  on public.ai_runs (operation, status, started_at desc);
create index if not exists idx_ai_runs_parent
  on public.ai_runs (parent_run_id) where parent_run_id is not null;
create index if not exists idx_ai_runs_user
  on public.ai_runs (user_id) where user_id is not null;
create index if not exists idx_ai_runs_project
  on public.ai_runs (project_id) where project_id is not null;
create index if not exists idx_ai_runs_task
  on public.ai_runs (task_id) where task_id is not null;
-- Corridas que cedieron el turno: mide la salud real del proveedor primario.
create index if not exists idx_ai_runs_fallback
  on public.ai_runs (provider, started_at desc) where fell_back_from is not null;

create index if not exists idx_audit_logs_actor
  on public.audit_logs (actor_id) where actor_id is not null;
create index if not exists idx_audit_logs_project
  on public.audit_logs (project_id) where project_id is not null;
create index if not exists idx_audit_logs_entity on public.audit_logs (entity_type, entity_id);
create index if not exists idx_audit_logs_created on public.audit_logs (created_at desc);

-- --- 07.6 Índices vectoriales (FASE 4) --------------------------------------------------------
-- HNSW con `vector_cosine_ops`, PARCIALES sobre `embedding is not null`.
--
-- IMPORTANTE para la FASE 4: para que el planificador use estos índices, la consulta debe
-- incluir el mismo predicado (`where embedding is not null`) y ordenar por `<=>`.
-- Cualquier otra forma de escribir la distancia provoca un seq scan de toda la tabla.
--
-- HNSW y no IVFFlat: IVFFlat necesita datos previos para entrenar las listas y
-- reconstrucción periódica según crece el corpus. HNSW no necesita entrenamiento, que es
-- el comportamiento correcto con una tabla que empieza vacía.
create index if not exists idx_provider_profiles_embedding_hnsw
  on public.provider_profiles using hnsw (embedding vector_cosine_ops)
  with (m = 16, ef_construction = 64)
  where embedding is not null;

create index if not exists idx_project_tasks_embedding_hnsw
  on public.project_tasks using hnsw (embedding vector_cosine_ops)
  with (m = 16, ef_construction = 64)
  where embedding is not null;


-- =====================================================================================
-- 08 · AUTORIZACIÓN Y RLS
-- =====================================================================================
-- Regla base: RLS activo en las 14 tablas y AUSENCIA DE POLÍTICA = DENEGACIÓN.
--
-- Los helpers son SECURITY DEFINER porque una política que consulta una tabla que a su vez
-- tiene RLS provoca recursión infinita de políticas.

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  select exists (
    select 1 from public.users u
    where u.id = auth.uid() and u.role = 'admin' and u.status = 'active'
  );
$function$;

create or replace function public.is_project_owner(p_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  select exists (
    select 1 from public.projects p
    where p.id = p_project_id and p.owner_id = auth.uid()
  );
$function$;

-- Un postulante también puede leer el proyecto: sin eso no podría evaluar a qué se postula.
create or replace function public.can_read_project(p_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  select exists (
    select 1 from public.projects p
    where p.id = p_project_id
      and (
        p.owner_id = auth.uid()
        or p.visibility = 'public'
        or exists (
          select 1 from public.project_tasks t
          where t.project_id = p.id and t.assignee_id = auth.uid()
        )
        or exists (
          select 1
          from public.task_applications a
          join public.project_tasks t on t.id = a.task_id
          where t.project_id = p.id and a.provider_id = auth.uid()
        )
      )
  );
$function$;

create or replace function public.can_read_task(p_task_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  select exists (
    select 1 from public.project_tasks t
    where t.id = p_task_id
      and (t.assignee_id = auth.uid() or public.can_read_project(t.project_id))
  );
$function$;

create or replace function public.is_task_owner(p_task_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  select exists (
    select 1
    from public.project_tasks t
    join public.projects p on p.id = t.project_id
    where t.id = p_task_id and p.owner_id = auth.uid()
  );
$function$;

create or replace function public.is_task_assignee(p_task_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  select exists (
    select 1 from public.project_tasks t
    where t.id = p_task_id and t.assignee_id = auth.uid()
  );
$function$;

create or replace function public.owns_provider_profile(p_provider_profile_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  select exists (
    select 1 from public.provider_profiles pp
    where pp.id = p_provider_profile_id and pp.user_id = auth.uid()
  );
$function$;

-- Una tarea acepta candidaturas solo mientras está abierta, sin asignar, en un proyecto
-- activo, y nadie puede postularse a su propio proyecto.
create or replace function public.task_accepts_applications(p_task_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  select exists (
    select 1
    from public.project_tasks t
    join public.projects p on p.id = t.project_id
    where t.id = p_task_id
      and t.status in ('ready', 'open', 'matching')
      and t.assignee_id is null
      and p.status in ('planned', 'active')
      and p.owner_id <> auth.uid()          -- nadie se postula a su propio proyecto
  );
$function$;

-- --- 08.1 Activación de RLS ----------------------------------------------------------------
do $$
declare
  v_table text;
begin
  foreach v_table in array array[
    'users', 'profiles', 'provider_profiles', 'skills', 'provider_skills',
    'projects', 'project_tasks', 'task_dependencies', 'task_applications',
    'deliverables', 'reviews', 'reputation_events', 'ai_runs', 'audit_logs'
  ] loop
    execute format('alter table public.%I enable row level security', v_table);
  end loop;
end $$;

-- --- 08.2 users -----------------------------------------------------------------------------
drop policy if exists users_select_self on public.users;
create policy users_select_self on public.users
  for select to authenticated
  using (id = auth.uid() or is_admin());

drop policy if exists users_insert_self on public.users;
create policy users_insert_self on public.users
  for insert to authenticated
  with check (id = auth.uid());

drop policy if exists users_update_self on public.users;
create policy users_update_self on public.users
  for update to authenticated
  using (id = auth.uid() or is_admin())
  with check (id = auth.uid() or is_admin());

drop policy if exists users_delete_admin on public.users;
create policy users_delete_admin on public.users
  for delete to authenticated
  using (is_admin());

-- --- 08.3 profiles ---------------------------------------------------------------------------
drop policy if exists profiles_select_authenticated on public.profiles;
create policy profiles_select_authenticated on public.profiles
  for select to authenticated using (true);

drop policy if exists profiles_insert_self on public.profiles;
create policy profiles_insert_self on public.profiles
  for insert to authenticated with check (user_id = auth.uid());

drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles
  for update to authenticated
  using (user_id = auth.uid() or is_admin())
  with check (user_id = auth.uid() or is_admin());

drop policy if exists profiles_delete_self on public.profiles;
create policy profiles_delete_self on public.profiles
  for delete to authenticated
  using (user_id = auth.uid() or is_admin());

-- --- 08.4 provider_profiles --------------------------------------------------------------------
drop policy if exists provider_profiles_select on public.provider_profiles;
create policy provider_profiles_select on public.provider_profiles
  for select to authenticated
  using (is_active or user_id = auth.uid() or is_admin());

drop policy if exists provider_profiles_insert_self on public.provider_profiles;
create policy provider_profiles_insert_self on public.provider_profiles
  for insert to authenticated with check (user_id = auth.uid());

drop policy if exists provider_profiles_update_self on public.provider_profiles;
create policy provider_profiles_update_self on public.provider_profiles
  for update to authenticated
  using (user_id = auth.uid() or is_admin())
  with check (user_id = auth.uid() or is_admin());

drop policy if exists provider_profiles_delete_self on public.provider_profiles;
create policy provider_profiles_delete_self on public.provider_profiles
  for delete to authenticated
  using (user_id = auth.uid() or is_admin());

-- --- 08.5 skills y provider_skills ----------------------------------------------------------------
drop policy if exists skills_select_all on public.skills;
create policy skills_select_all on public.skills
  for select to anon, authenticated
  using (is_active or is_admin());

drop policy if exists skills_write_admin on public.skills;
create policy skills_write_admin on public.skills
  for all to authenticated
  using (is_admin()) with check (is_admin());

drop policy if exists provider_skills_select on public.provider_skills;
create policy provider_skills_select on public.provider_skills
  for select to authenticated
  using (
    owns_provider_profile(provider_profile_id)
    or exists (
      select 1 from public.provider_profiles pp
      where pp.id = provider_skills.provider_profile_id and pp.is_active
    )
    or is_admin()
  );

drop policy if exists provider_skills_insert_own on public.provider_skills;
create policy provider_skills_insert_own on public.provider_skills
  for insert to authenticated with check (owns_provider_profile(provider_profile_id));

drop policy if exists provider_skills_update_own on public.provider_skills;
create policy provider_skills_update_own on public.provider_skills
  for update to authenticated
  using (owns_provider_profile(provider_profile_id))
  with check (owns_provider_profile(provider_profile_id));

drop policy if exists provider_skills_delete_own on public.provider_skills;
create policy provider_skills_delete_own on public.provider_skills
  for delete to authenticated using (owns_provider_profile(provider_profile_id));

-- --- 08.6 projects -----------------------------------------------------------------------------
drop policy if exists projects_select on public.projects;
create policy projects_select on public.projects
  for select to authenticated
  using (owner_id = auth.uid() or can_read_project(id) or is_admin());

drop policy if exists projects_insert_own on public.projects;
create policy projects_insert_own on public.projects
  for insert to authenticated with check (owner_id = auth.uid());

drop policy if exists projects_update_own on public.projects;
create policy projects_update_own on public.projects
  for update to authenticated
  using (owner_id = auth.uid() or is_admin())
  with check (owner_id = auth.uid() or is_admin());

drop policy if exists projects_delete_own on public.projects;
create policy projects_delete_own on public.projects
  for delete to authenticated using (owner_id = auth.uid() or is_admin());

-- --- 08.7 project_tasks ------------------------------------------------------------------------
drop policy if exists project_tasks_select on public.project_tasks;
create policy project_tasks_select on public.project_tasks
  for select to authenticated
  using (assignee_id = auth.uid() or can_read_project(project_id) or is_admin());

drop policy if exists project_tasks_insert_owner on public.project_tasks;
create policy project_tasks_insert_owner on public.project_tasks
  for insert to authenticated with check (is_project_owner(project_id));

-- El asignado entra aquí, pero `enforce_task_assignee_scope` limita QUÉ columnas puede
-- tocar: RLS es por fila, no por columna.
drop policy if exists project_tasks_update on public.project_tasks;
create policy project_tasks_update on public.project_tasks
  for update to authenticated
  using (is_project_owner(project_id) or assignee_id = auth.uid() or is_admin())
  with check (is_project_owner(project_id) or assignee_id = auth.uid() or is_admin());

drop policy if exists project_tasks_delete_owner on public.project_tasks;
create policy project_tasks_delete_owner on public.project_tasks
  for delete to authenticated using (is_project_owner(project_id) or is_admin());

-- --- 08.8 task_dependencies -----------------------------------------------------------------------
drop policy if exists task_dependencies_select on public.task_dependencies;
create policy task_dependencies_select on public.task_dependencies
  for select to authenticated using (can_read_task(task_id) or is_admin());

-- Se exige ser dueño de AMBOS extremos: si no, se podría enganchar una tarea ajena al
-- propio grafo y bloquearla.
drop policy if exists task_dependencies_insert_owner on public.task_dependencies;
create policy task_dependencies_insert_owner on public.task_dependencies
  for insert to authenticated
  with check (is_task_owner(task_id) and is_task_owner(depends_on_task_id));

drop policy if exists task_dependencies_update_owner on public.task_dependencies;
create policy task_dependencies_update_owner on public.task_dependencies
  for update to authenticated
  using (is_task_owner(task_id))
  with check (is_task_owner(task_id) and is_task_owner(depends_on_task_id));

drop policy if exists task_dependencies_delete_owner on public.task_dependencies;
create policy task_dependencies_delete_owner on public.task_dependencies
  for delete to authenticated using (is_task_owner(task_id) or is_admin());

-- --- 08.9 task_applications --------------------------------------------------------------------------
drop policy if exists task_applications_select on public.task_applications;
create policy task_applications_select on public.task_applications
  for select to authenticated
  using (provider_id = auth.uid() or is_task_owner(task_id) or is_admin());

drop policy if exists task_applications_insert_self on public.task_applications;
create policy task_applications_insert_self on public.task_applications
  for insert to authenticated
  with check (provider_id = auth.uid() and task_accepts_applications(task_id));

drop policy if exists task_applications_update on public.task_applications;
create policy task_applications_update on public.task_applications
  for update to authenticated
  using (provider_id = auth.uid() or is_task_owner(task_id) or is_admin())
  with check (provider_id = auth.uid() or is_task_owner(task_id) or is_admin());

drop policy if exists task_applications_delete_self on public.task_applications;
create policy task_applications_delete_self on public.task_applications
  for delete to authenticated using (provider_id = auth.uid() or is_admin());

-- --- 08.10 deliverables -----------------------------------------------------------------------------
drop policy if exists deliverables_select on public.deliverables;
create policy deliverables_select on public.deliverables
  for select to authenticated
  using (provider_id = auth.uid() or is_task_owner(task_id) or is_admin());

drop policy if exists deliverables_insert_assignee on public.deliverables;
create policy deliverables_insert_assignee on public.deliverables
  for insert to authenticated
  with check (provider_id = auth.uid() and is_task_assignee(task_id));

-- El proveedor solo puede reeditar mientras el AI Judge no lo haya juzgado (o pidió cambios).
drop policy if exists deliverables_update on public.deliverables;
create policy deliverables_update on public.deliverables
  for update to authenticated
  using (
    (provider_id = auth.uid()
      and qa_status in ('pending', 'revision_requested', 'error'))
    or is_task_owner(task_id) or is_admin()
  )
  with check (
    (provider_id = auth.uid()
      and qa_status in ('pending', 'revision_requested', 'error'))
    or is_task_owner(task_id) or is_admin()
  );

drop policy if exists deliverables_delete_admin on public.deliverables;
create policy deliverables_delete_admin on public.deliverables
  for delete to authenticated using (is_admin());

-- --- 08.11 reviews ------------------------------------------------------------------------------------
drop policy if exists reviews_select on public.reviews;
create policy reviews_select on public.reviews
  for select to authenticated
  using (
    (is_public and can_read_task(task_id))
    or reviewer_id = auth.uid()
    or reviewee_id = auth.uid()
    or is_task_owner(task_id)
    or is_admin()
  );

-- Una persona solo firma su propia reseña y no puede autoevaluarse. El AI Judge entra por
-- `service_role`, que bypassea RLS.
drop policy if exists reviews_insert_participant on public.reviews;
create policy reviews_insert_participant on public.reviews
  for insert to authenticated
  with check (
    reviewer_id = auth.uid()
    and source = 'human'
    and reviewee_id <> auth.uid()
    and (is_task_owner(task_id) or is_task_assignee(task_id))
  );

drop policy if exists reviews_update_own on public.reviews;
create policy reviews_update_own on public.reviews
  for update to authenticated
  using (reviewer_id = auth.uid() or is_admin())
  with check (reviewer_id = auth.uid() or is_admin());

drop policy if exists reviews_delete_own on public.reviews;
create policy reviews_delete_own on public.reviews
  for delete to authenticated using (reviewer_id = auth.uid() or is_admin());

-- --- 08.12 reputation_events, ai_runs y audit_logs ----------------------------------------------------
-- Las tres son de SOLO LECTURA para el tráfico de PostgREST: no hay política de INSERT,
-- UPDATE ni DELETE. Solo escribe `service_role`, que bypassea RLS.

drop policy if exists reputation_events_select_own on public.reputation_events;
create policy reputation_events_select_own on public.reputation_events
  for select to authenticated using (user_id = auth.uid() or is_admin());

-- Los payloads pueden contener el objetivo del cliente: solo el dueño del proyecto.
drop policy if exists ai_runs_select_own on public.ai_runs;
create policy ai_runs_select_own on public.ai_runs
  for select to authenticated
  using (
    user_id = auth.uid()
    or (project_id is not null and is_project_owner(project_id))
    or is_admin()
  );

drop policy if exists audit_logs_select_own on public.audit_logs;
create policy audit_logs_select_own on public.audit_logs
  for select to authenticated
  using (
    actor_id = auth.uid()
    or (project_id is not null and is_project_owner(project_id))
    or is_admin()
  );


-- =====================================================================================
-- 09 · PRIVILEGIOS POR ROL
-- =====================================================================================
-- Trampa de PostgreSQL: toda función nueva recibe EXECUTE para PUBLIC. `revoke ... from
-- anon` NO cierra nada, porque `anon` lo hereda igualmente de PUBLIC. Hay que revocar de
-- PUBLIC y luego conceder explícitamente.

grant usage on schema public     to anon, authenticated, service_role;
grant usage on schema extensions to anon, authenticated, service_role;

grant select on all tables in schema public to anon, authenticated;
grant insert, update, delete on all tables in schema public to authenticated;
grant all on all tables in schema public to service_role;

alter default privileges in schema public grant select on tables to anon, authenticated;
alter default privileges in schema public
  grant insert, update, delete on tables to authenticated;
alter default privileges in schema public grant all on tables to service_role;

do $$
declare
  v_function text;
begin
  foreach v_function in array array[
    'is_project_owner(uuid)', 'can_read_project(uuid)', 'can_read_task(uuid)',
    'is_task_owner(uuid)', 'is_task_assignee(uuid)', 'owns_provider_profile(uuid)',
    'task_accepts_applications(uuid)'
  ] loop
    execute format('revoke all on function public.%s from public', v_function);
    execute format(
      'grant execute on function public.%s to authenticated, service_role', v_function);
  end loop;
end $$;

-- `is_admin()` CONSERVA el EXECUTE de `anon` a propósito.
--
-- Una política RLS que invoca una función exige que el ROL EVALUADO tenga EXECUTE sobre
-- ella. `skills_select_all` es `to anon, authenticated` e invoca `is_admin()`: al
-- revocarlo de `anon`, TODA lectura de `public.skills` falla con "permission denied for
-- function is_admin". Es inocuo mantenerlo: con `anon`, `auth.uid()` es NULL y devuelve false.
revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to anon, authenticated, service_role;

-- Las funciones de trigger no se invocan directamente: nadie necesita EXECUTE.
do $$
declare
  v_function text;
begin
  foreach v_function in array array[
    'set_updated_at()', 'forbid_mutation()', 'set_deliverable_version()',
    'prevent_dag_cycles()', 'prevent_task_parent_cycles()', 'apply_reputation_event()',
    'refresh_provider_rating()', 'enforce_user_self_update_scope()',
    'enforce_task_assignee_scope()', 'handle_new_auth_user()'
  ] loop
    execute format('revoke all on function public.%s from public', v_function);
    execute format('grant execute on function public.%s to service_role', v_function);
  end loop;
end $$;


-- =====================================================================================
-- FIN — db/schema.sql
-- Siguiente: db/migrations/0002_planner.sql, y luego db/seeds/01_skills.sql
-- =====================================================================================
