-- =====================================================================================
-- VEKTORA · FASE 3 — Migración del ProjectPlanner
-- =====================================================================================
-- Aplicar DESPUÉS de db/schema.sql. Idempotente: reaplicarla no tiene efecto.
--
-- PROCEDENCIA: reconstruida el 2026-09-14 desde `pg_get_functiondef` de la base realmente
-- desplegada. Los cuerpos de función son literales, no una reinterpretación.
--
-- Contenido:
--   01 · `refresh_task_readiness` — motor de avance blocked <-> ready
--   02 · `propagate_task_readiness` + trigger
--   03 · `apply_project_plan` — persistencia transaccional del DAG en UNA llamada
--   04 · `register_skills` — el catálogo crece solo (requisito de autonomía)
--   05 · `project_dag` — lectura del grafo completo como JSON
--   06 · Endurecimiento de privilegios
-- =====================================================================================

set search_path = public, extensions;


-- =====================================================================================
-- 01 · refresh_task_readiness — el motor de avance del DAG
-- =====================================================================================
-- `blocked -> ready` cuando TODAS las dependencias están `approved`, y el camino inverso
-- si una se reabre por revisión. Es lo que hace que el proyecto avance solo.
--
-- Solo toca tareas en `blocked` o `ready`: una tarea `assigned` o `in_progress` no vuelve
-- atrás por este mecanismo.

create or replace function public.refresh_task_readiness(p_project_id uuid default null::uuid)
returns integer
language plpgsql
set search_path to 'public', 'extensions', 'pg_temp'
as $function$
declare
  v_changed integer := 0;
begin
  with candidate as (
    select
      t.id,
      t.status,
      count(d.depends_on_task_id)                                              as total_deps,
      count(*) filter (where upstream.status = 'approved')                      as satisfied_deps
    from public.project_tasks t
    left join public.task_dependencies d on d.task_id = t.id
    left join public.project_tasks upstream on upstream.id = d.depends_on_task_id
    where (p_project_id is null or t.project_id = p_project_id)
      and t.status in ('blocked', 'ready')
    group by t.id, t.status
  ),
  target as (
    select
      id,
      status,
      case when total_deps = satisfied_deps then 'ready'::public.task_status
           else 'blocked'::public.task_status end as next_status
    from candidate
  )
  update public.project_tasks t
     set status = target.next_status,
         updated_at = now()
    from target
   where t.id = target.id
     and t.status <> target.next_status;

  get diagnostics v_changed = row_count;
  return v_changed;
end;
$function$;

comment on function public.refresh_task_readiness(uuid) is
  'blocked <-> ready según el estado de las dependencias. Devuelve cuántas tareas cambió.';


-- =====================================================================================
-- 02 · Propagación automática
-- =====================================================================================

create or replace function public.propagate_task_readiness()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'extensions', 'pg_temp'
as $function$
begin
  perform public.refresh_task_readiness(new.project_id);
  return null;
end;
$function$;

-- El filtro del WHEN es lo que evita la recursión: la función nunca escribe `approved`,
-- así que sus propias actualizaciones no vuelven a disparar el trigger.
drop trigger if exists trg_propagate_task_readiness on public.project_tasks;
create trigger trg_propagate_task_readiness
  after update of status on public.project_tasks
  for each row
  when (new.status is distinct from old.status
        and (new.status = 'approved' or old.status = 'approved'))
  execute function public.propagate_task_readiness();


-- =====================================================================================
-- 03 · apply_project_plan — persistencia transaccional del plan
-- =====================================================================================
-- Por qué una RPC y no N llamadas desde el cliente: supabase-js NO tiene transacciones
-- multi-sentencia. Persistir N tareas y M aristas por separado costaría 2+N+M idas y
-- vueltas y, si algo fallara a mitad, dejaría un DAG parcial en la base.
--
-- SECURITY INVOKER (el modo por defecto) a propósito: `service_role` bypassea RLS (es el
-- ProjectPlanner autónomo), pero un usuario autenticado queda sujeto a las políticas y por
-- tanto NO puede plantar un plan en un proyecto ajeno.
--
-- SEMÁNTICA DE REPLANIFICACIÓN
--   · El plan nuevo es autoritativo: SUSTITUYE todas las aristas del proyecto.
--   · Las tareas con proveedor asignado o con entregables NO se borran. Es deliberado:
--     un replan automático no destruye trabajo ya pagado.
--
-- Entrada:
--   p_tasks        : [{code,title,description,acceptance_criteria,required_skills,
--                      estimated_hours,budget,priority,order_index,depth,status}, …]
--   p_dependencies : [{task_code, depends_on_code, dependency_type?}, …]
-- Salida: {project_id, task_count, inserted_tasks, edge_count, task_ids:{code -> uuid}}

create or replace function public.apply_project_plan(
  p_project_id       uuid,
  p_tasks            jsonb,
  p_dependencies     jsonb default '[]'::jsonb,
  p_planner_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
set search_path to 'public', 'extensions', 'pg_temp'
as $function$
declare
  v_owner        uuid;
  v_task_count   integer;
  v_edge_count   integer;
  v_code_count   integer;
  v_ids          jsonb;
begin
  if p_project_id is null then
    raise exception 'VEKTORA/PLANNER: p_project_id es obligatorio' using errcode = '22004';
  end if;

  if jsonb_typeof(p_tasks) <> 'array' or jsonb_array_length(p_tasks) = 0 then
    raise exception 'VEKTORA/PLANNER: p_tasks debe ser un arreglo JSON no vacío'
      using errcode = '22023';
  end if;

  if jsonb_typeof(p_dependencies) <> 'array' then
    raise exception 'VEKTORA/PLANNER: p_dependencies debe ser un arreglo JSON'
      using errcode = '22023';
  end if;

  -- El proyecto tiene que existir Y ser visible para el invocante. Con RLS activo, un
  -- usuario sin acceso simplemente no lo encuentra.
  select owner_id into v_owner from public.projects where id = p_project_id;
  if v_owner is null then
    raise exception 'VEKTORA/PLANNER: proyecto % inexistente o sin acceso', p_project_id
      using errcode = '42501';
  end if;

  -- Códigos duplicados: se detecta aquí además de en Zod porque esta RPC también puede
  -- invocarse desde fuera del planificador.
  select count(distinct t->>'code'), count(*)
    into v_code_count, v_task_count
  from jsonb_array_elements(p_tasks) t;

  if v_code_count <> v_task_count then
    raise exception 'VEKTORA/PLANNER: hay códigos de tarea duplicados en p_tasks'
      using errcode = '23505';
  end if;

  -- Replanificación: se borra el DAG anterior. ON DELETE CASCADE de task_dependencies se
  -- encarga de las aristas. Se conservan las tareas ya asignadas o entregadas para no
  -- destruir trabajo en curso.
  delete from public.project_tasks t
   where t.project_id = p_project_id
     and t.assignee_id is null
     and t.status in ('blocked', 'ready', 'open', 'matching', 'cancelled', 'failed')
     and not exists (select 1 from public.deliverables d where d.task_id = t.id);

  -- --- Tareas ---
  insert into public.project_tasks (
    project_id, code, title, description, acceptance_criteria, required_skills,
    estimated_hours, budget, priority, order_index, depth, status
  )
  select
    p_project_id,
    t->>'code',
    t->>'title',
    nullif(t->>'description', ''),
    coalesce(t->'acceptance_criteria', '[]'::jsonb),
    coalesce(
      (select array_agg(value::text) from jsonb_array_elements_text(t->'required_skills')),
      '{}'::text[]
    ),
    nullif(t->>'estimated_hours', '')::numeric,
    nullif(t->>'budget', '')::numeric,
    coalesce(nullif(t->>'priority', '')::smallint, 3),
    coalesce(nullif(t->>'order_index', '')::integer, 0),
    coalesce(nullif(t->>'depth', '')::smallint, 0),
    coalesce(nullif(t->>'status', '')::public.task_status, 'blocked')
  from jsonb_array_elements(p_tasks) t
  on conflict (project_id, code) do update
    set title               = excluded.title,
        description         = excluded.description,
        acceptance_criteria = excluded.acceptance_criteria,
        required_skills     = excluded.required_skills,
        estimated_hours     = excluded.estimated_hours,
        budget              = excluded.budget,
        priority            = excluded.priority,
        order_index         = excluded.order_index,
        depth               = excluded.depth,
        updated_at          = now();

  -- --- Aristas ---
  -- Se reemplazan todas las del proyecto: el DAG nuevo manda.
  delete from public.task_dependencies d
   where d.task_id in (select id from public.project_tasks where project_id = p_project_id);

  insert into public.task_dependencies (task_id, depends_on_task_id, dependency_type, created_by)
  select
    child.id,
    parent.id,
    coalesce(nullif(e->>'dependency_type', '')::public.dependency_type, 'finish_to_start'),
    'ai_agent'
  from jsonb_array_elements(p_dependencies) e
  join public.project_tasks child
    on child.project_id = p_project_id and child.code = e->>'task_code'
  join public.project_tasks parent
    on parent.project_id = p_project_id and parent.code = e->>'depends_on_code'
  on conflict (task_id, depends_on_task_id) do nothing;

  select count(*) into v_edge_count
  from public.task_dependencies d
  join public.project_tasks t on t.id = d.task_id
  where t.project_id = p_project_id;

  -- --- Proyecto ---
  update public.projects
     set status           = case when status in ('draft', 'planning') then 'planned'
                                else status end,
         planner_metadata = coalesce(p_planner_metadata, '{}'::jsonb),
         dag_generated_at = now(),
         updated_at       = now()
   where id = p_project_id;

  -- Coherencia final: nadie debe quedar en 'blocked' sin dependencias.
  perform public.refresh_task_readiness(p_project_id);

  select jsonb_object_agg(code, id) into v_ids
  from public.project_tasks where project_id = p_project_id;

  return jsonb_build_object(
    'project_id', p_project_id,
    'task_count', (select count(*) from public.project_tasks where project_id = p_project_id),
    'inserted_tasks', v_task_count,
    'edge_count', v_edge_count,
    'task_ids', coalesce(v_ids, '{}'::jsonb)
  );
end;
$function$;

comment on function public.apply_project_plan(uuid, jsonb, jsonb, jsonb) is
  'Persiste un plan completo (tareas + aristas + metadatos) de forma atómica.';


-- =====================================================================================
-- 04 · register_skills — el catálogo crece solo
-- =====================================================================================
-- Requisito de autonomía: si el planificador necesita una skill que no está en el
-- catálogo, la añade en categoría `auto` en vez de esperar a que alguien la dé de alta.
-- Que esto falle no invalida un plan: `project_tasks.required_skills` es `text[]` y no
-- tiene FK contra `skills`.

create or replace function public.register_skills(p_slugs text[])
returns integer
language plpgsql
set search_path to 'public', 'extensions', 'pg_temp'
as $function$
declare
  v_inserted integer := 0;
begin
  if p_slugs is null or array_length(p_slugs, 1) is null then
    return 0;
  end if;

  insert into public.skills (slug, name, category)
  select distinct
    s,
    initcap(replace(s, '-', ' ')),
    'auto'
  from unnest(p_slugs) s
  where s is not null and s <> ''
  on conflict (slug) do nothing;

  get diagnostics v_inserted = row_count;
  return v_inserted;
end;
$function$;

comment on function public.register_skills(text[]) is
  'Da de alta slugs de skill desconocidos en categoría auto. Idempotente.';


-- =====================================================================================
-- 05 · project_dag — lectura del grafo completo
-- =====================================================================================
-- Es una FUNCIÓN, no una vista: devuelve el grafo entero de un proyecto en UN jsonb
-- (tareas + aristas por código), que es lo que necesita el visualizador de la FASE 6 sin
-- hacer dos consultas y unirlas en el cliente.
--
--   select public.project_dag('<uuid>');
--   supabase.rpc('project_dag', { p_project_id: id })

create or replace function public.project_dag(p_project_id uuid)
returns jsonb
language sql
stable
set search_path to 'public', 'extensions', 'pg_temp'
as $function$
  select jsonb_build_object(
    'project_id', p_project_id,
    'tasks', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', t.id,
               'code', t.code,
               'title', t.title,
               'status', t.status,
               'priority', t.priority,
               'depth', t.depth,
               'order_index', t.order_index,
               'estimated_hours', t.estimated_hours,
               'budget', t.budget,
               'required_skills', t.required_skills,
               'assignee_id', t.assignee_id,
               'has_embedding', t.embedding is not null
             ) order by t.order_index, t.code)
      from public.project_tasks t
      where t.project_id = p_project_id
    ), '[]'::jsonb),
    'edges', coalesce((
      select jsonb_agg(jsonb_build_object(
               'task_code', child.code,
               'depends_on_code', parent.code,
               'dependency_type', d.dependency_type
             ) order by child.code, parent.code)
      from public.task_dependencies d
      join public.project_tasks child on child.id = d.task_id
      join public.project_tasks parent on parent.id = d.depends_on_task_id
      where child.project_id = p_project_id
    ), '[]'::jsonb)
  );
$function$;

comment on function public.project_dag(uuid) is
  'Grafo completo del proyecto como jsonb. STABLE y sin SECURITY DEFINER: respeta RLS.';


-- =====================================================================================
-- 06 · ENDURECIMIENTO DE PRIVILEGIOS
-- =====================================================================================
-- PostgreSQL concede EXECUTE a PUBLIC en toda función nueva, así que `revoke ... from
-- anon` no cierra nada: `anon` lo hereda de PUBLIC igualmente. Sin estas líneas, un
-- cliente con la clave anónima podía invocar `apply_project_plan` directamente.
--
-- `apply_project_plan` y `project_dag` respetan RLS (no son SECURITY DEFINER), así que
-- aunque se llamen no filtran nada; aun así no hay razón para exponer la superficie.
-- `refresh_task_readiness` y `register_skills` escriben, y quedan solo para service_role.

revoke all on function public.apply_project_plan(uuid, jsonb, jsonb, jsonb) from public;
grant execute on function public.apply_project_plan(uuid, jsonb, jsonb, jsonb)
  to authenticated, service_role;

revoke all on function public.project_dag(uuid) from public;
grant execute on function public.project_dag(uuid) to authenticated, service_role;

revoke all on function public.refresh_task_readiness(uuid) from public;
grant execute on function public.refresh_task_readiness(uuid) to service_role;

revoke all on function public.register_skills(text[]) from public;
grant execute on function public.register_skills(text[]) to service_role;

revoke all on function public.propagate_task_readiness() from public;
grant execute on function public.propagate_task_readiness() to service_role;


-- =====================================================================================
-- FIN — db/migrations/0002_planner.sql
-- Siguiente: db/seeds/01_skills.sql   ·   Verificación: npm run db:check
-- =====================================================================================
