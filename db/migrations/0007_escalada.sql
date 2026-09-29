-- =========================================================================================
-- VEKTORA · FASE 7 — Escalada del emparejamiento y cuotas de uso
-- =========================================================================================
-- Depende de: db/schema.sql, migraciones 0002 a 0006.
-- Idempotente: se puede reaplicar sobre una base ya desplegada.
--
-- Resuelve dos formas de romper el sistema que no producen ningún error:
--
--   1. UNA TAREA QUE NUNCA SUPERA EL UMBRAL se queda en `matching` para siempre, con una
--      candidatura pendiente que nadie puede aceptar — porque aquí no hay nadie. Todo lo
--      que dependa de ella queda bloqueado. Ocurrió de verdad: dos tareas puntuaron 0.492
--      y 0.468 contra un umbral de 0.50 y se pararon.
--
--   2. UN USUARIO SIN LÍMITE agota la cuota de IA del free tier para todos los demás.
--      Planificar un proyecto cuesta una llamada al modelo más una vectorización por
--      tarea; tres personas curiosas dejan el sistema sin servicio en una tarde.
-- =========================================================================================

-- Mismo preámbulo que `db/schema.sql`: las extensiones viven en su propio esquema, así que
-- sin esto `uuid_generate_v4()` no se resuelve.
set search_path = public, extensions;


-- =========================================================================================
-- 01 · Contador de rondas de emparejamiento
-- =========================================================================================
-- Rondas y no tiempo transcurrido, a propósito. En producción el reloj dispara cada 15
-- minutos, así que cuatro rondas es una hora; pero en una demostración basta con ejecutar
-- el disparador cuatro veces. Medido en horas, la escalada sería imposible de mostrar.
alter table public.project_tasks
  add column if not exists matching_rounds integer not null default 0;

comment on column public.project_tasks.matching_rounds is
  'Veces que el emparejador puntuó candidatos para esta tarea sin llegar a adjudicarla. '
  'Al superar el tope configurado, la política acepta al mejor candidato por encima del '
  'mínimo en lugar de dejar la tarea bloqueada para siempre.';

create index if not exists idx_project_tasks_matching_rounds
  on public.project_tasks (matching_rounds)
  where assignee_id is null;

-- La cuenta se lleva en la base y no en el cliente: dos disparadores solapados tienen que
-- ver el mismo número, y un contador en memoria se reiniciaría en cada despliegue.
create or replace function public.bump_matching_round(p_task_id uuid)
returns integer
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_rondas integer;
begin
  update public.project_tasks
     set matching_rounds = matching_rounds + 1,
         updated_at = now()
   where id = p_task_id
     and assignee_id is null
  returning matching_rounds into v_rondas;

  -- Sin fila significa que la tarea ya tiene proveedor: la ronda no cuenta.
  return coalesce(v_rondas, 0);
end;
$function$;

-- Al adjudicarse, el contador vuelve a cero. Si la tarea se reabre por una revisión, la
-- siguiente búsqueda arranca con el mercado en igualdad de condiciones.
create or replace function public.reset_matching_rounds()
returns trigger
language plpgsql
as $function$
begin
  if new.assignee_id is not null and old.assignee_id is null then
    new.matching_rounds := 0;
  end if;
  return new;
end;
$function$;

drop trigger if exists trg_reset_matching_rounds on public.project_tasks;
create trigger trg_reset_matching_rounds
  before update of assignee_id on public.project_tasks
  for each row execute function public.reset_matching_rounds();


-- =========================================================================================
-- 02 · Cuotas de uso
-- =========================================================================================
-- Ventana deslizante por usuario y acción. Se cuenta en la base porque es el único sitio
-- donde el recuento es atómico: dos peticiones simultáneas del mismo usuario no pueden
-- consumir el mismo hueco.
create table if not exists public.usage_events (
  id         uuid primary key default uuid_generate_v4(),
  user_id    uuid not null references public.users (id) on delete cascade,
  action     text not null,
  created_at timestamptz not null default now(),
  constraint usage_events_action_no_vacio check (length(trim(action)) > 0)
);

create index if not exists idx_usage_events_ventana
  on public.usage_events (user_id, action, created_at desc);

alter table public.usage_events enable row level security;

-- Cada quien ve su propio consumo. La escritura solo ocurre desde la función de abajo,
-- que es SECURITY DEFINER: nadie puede fabricarse huecos insertando a mano.
drop policy if exists usage_events_select_own on public.usage_events;
create policy usage_events_select_own on public.usage_events
  for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

/**
 * Comprueba y consume un hueco de cuota EN LA MISMA TRANSACCIÓN.
 *
 * Partirlo en «contar» y luego «registrar» abriría la carrera que esta función existe para
 * cerrar: dos pestañas pulsando a la vez pasarían ambas la comprobación.
 *
 * Devuelve el estado de la cuota. NO lanza: el llamador decide qué mensaje mostrar, y una
 * excepción aquí se confundiría con un fallo del sistema.
 */
create or replace function public.consume_quota(
  p_user_id       uuid,
  p_action        text,
  p_limit         integer,
  p_window_hours  numeric
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_desde   timestamptz := now() - make_interval(secs => p_window_hours * 3600);
  v_usados  integer;
  v_proximo timestamptz;
begin
  if p_limit <= 0 then
    return jsonb_build_object('permitido', false, 'usados', 0, 'limite', p_limit,
                              'motivo', 'la acción está deshabilitada por configuración');
  end if;

  -- `for update` sobre las filas de la ventana: serializa a los llamadores concurrentes
  -- del MISMO usuario y acción, sin bloquear a nadie más.
  perform 1
    from public.usage_events
   where user_id = p_user_id and action = p_action and created_at >= v_desde
   for update;

  select count(*) into v_usados
    from public.usage_events
   where user_id = p_user_id and action = p_action and created_at >= v_desde;

  if v_usados >= p_limit then
    select min(created_at) + make_interval(secs => p_window_hours * 3600)
      into v_proximo
      from public.usage_events
     where user_id = p_user_id and action = p_action and created_at >= v_desde;

    return jsonb_build_object(
      'permitido', false,
      'usados', v_usados,
      'limite', p_limit,
      'disponible_en', v_proximo,
      'motivo', 'cuota agotada'
    );
  end if;

  insert into public.usage_events (user_id, action) values (p_user_id, p_action);

  return jsonb_build_object(
    'permitido', true,
    'usados', v_usados + 1,
    'limite', p_limit,
    'restantes', p_limit - v_usados - 1
  );
end;
$function$;

/** Consumo actual sin consumir nada. Para mostrárselo al usuario antes de que choque. */
create or replace function public.quota_usage(
  p_user_id      uuid,
  p_action       text,
  p_window_hours numeric
)
returns integer
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  select count(*)::integer
    from public.usage_events
   where user_id = p_user_id
     and action = p_action
     and created_at >= now() - make_interval(secs => p_window_hours * 3600);
$function$;


-- =========================================================================================
-- 03 · Privilegios
-- =========================================================================================
-- PostgreSQL concede EXECUTE a PUBLIC en cada función nueva, así que revocar solo a `anon`
-- no cierra nada. Estas tres las invocan los agentes con `service_role`, que no necesita
-- GRANT porque bypassea RLS; ningún rol de cliente debe poder fabricarse cuota.
do $$
declare
  v_fn text;
begin
  foreach v_fn in array array[
    'public.bump_matching_round(uuid)',
    'public.consume_quota(uuid, text, integer, numeric)',
    'public.quota_usage(uuid, text, numeric)'
  ]
  loop
    execute format('revoke all on function %s from public', v_fn);
    execute format('revoke all on function %s from anon, authenticated', v_fn);
  end loop;
end $$;
