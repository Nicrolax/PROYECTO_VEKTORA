-- =========================================================================================
-- VEKTORA · FASE 5 — Agente autónomo de QA (AI Judge)
-- =========================================================================================
-- Depende de: db/schema.sql, db/migrations/0002_planner.sql
-- Idempotente: se puede reaplicar sobre una base ya desplegada.
--
-- Igual que en la FASE 4, aquí vive SOLO lo que únicamente la base puede hacer:
-- tomar el turno sin carreras y escribir el veredicto entero en una transacción. El
-- criterio —qué puntuación aprueba, cuánta reputación se mueve, cuántos rechazos agotan
-- una tarea— es política de producto y vive en `lib/qa/policy.ts`, que es puro y testeable.
--
-- Tres invariantes que esta migración defiende y el código de aplicación no podría:
--
--   1. UN SOLO JUEZ POR ENTREGABLE A LA VEZ. `claim_deliverable_for_qa` toma el turno con
--      `for update` y mueve `qa_status` a 'running'. Dos procesos concurrentes no pueden
--      juzgar el mismo entregable ni cobrar dos veces la reputación.
--
--   2. UN VEREDICTO YA EMITIDO NO SE REESCRIBE. Solo se juzga desde
--      ('pending', 'revision_requested', 'error'). Un entregable 'approved' es terminal:
--      sin esto, reejecutar el juez sobre trabajo ya aprobado podría revocarlo solo porque
--      el modelo tuvo un mal día.
--
--   3. LA REPUTACIÓN NO SE COBRA DOS VECES. `reputation_events` es append-only (no se puede
--      borrar ni corregir), así que el guardia es previo: no se inserta un `event_type` que
--      ese entregable ya generó. Si un veredicto posterior contradice a otro, se AÑADE el
--      evento contrario en vez de borrar el anterior; el saldo se reconstruye sumando, que
--      es justo lo que un libro mayor debe permitir.
-- =========================================================================================

-- =========================================================================================
-- 01 · claim_deliverable_for_qa — tomar el turno y devolver todo lo que el juez necesita
-- =========================================================================================
-- Una sola ida y vuelta: bloquea, marca 'running' y devuelve entregable + tarea + criterios
-- + proyecto. Partirlo en "leer" y luego "marcar" abriría exactamente la carrera que esta
-- función existe para cerrar.
create or replace function public.claim_deliverable_for_qa(p_deliverable_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_current public.qa_status;
  v_result  jsonb;
begin
  select d.qa_status into v_current
    from public.deliverables d
   where d.id = p_deliverable_id
   for update;

  if not found then
    return jsonb_build_object(
      'claimed', false,
      'reason', 'no existe ningún entregable con ese id'
    );
  end if;

  if v_current not in ('pending', 'revision_requested', 'error') then
    return jsonb_build_object(
      'claimed', false,
      'qa_status', v_current,
      'reason', format(
        'el entregable está en qa_status=%s: %s',
        v_current,
        case v_current
          when 'running'  then 'otro juez lo tiene tomado ahora mismo'
          when 'approved' then 'ya fue aprobado y el veredicto es terminal'
          when 'rejected' then 'ya fue rechazado y el veredicto es terminal'
          else 'no admite juicio automático'
        end
      )
    );
  end if;

  update public.deliverables
     set qa_status  = 'running',
         updated_at = now()
   where id = p_deliverable_id;

  select jsonb_build_object(
    'claimed', true,
    'previous_status', v_current,
    'deliverable', jsonb_build_object(
      'id',           d.id,
      'task_id',      d.task_id,
      'provider_id',  d.provider_id,
      'version',      d.version,
      'summary',      d.summary,
      'content',      d.content,
      'artifacts',    d.artifacts,
      'evidence',     d.evidence,
      'submitted_at', d.submitted_at
    ),
    'task', jsonb_build_object(
      'id',                  t.id,
      'project_id',          t.project_id,
      'code',                t.code,
      'title',               t.title,
      'description',         t.description,
      'acceptance_criteria', t.acceptance_criteria,
      'required_skills',     t.required_skills,
      'status',              t.status,
      'assignee_id',         t.assignee_id,
      'budget',              t.budget,
      'estimated_hours',     t.estimated_hours
    ),
    'project', jsonb_build_object(
      'id',        p.id,
      'title',     p.title,
      'objective', p.objective
    ),
    -- Rechazos previos de ESTA tarea. La política de escalado los necesita: rechazar para
    -- siempre al primer intento sería tan malo como no rechazar nunca.
    'previous_rejections', (
      select count(*)
        from public.reputation_events re
       where re.task_id = d.task_id
         and re.event_type = 'deliverable_rejected'
    )
  )
  into v_result
  from public.deliverables d
  join public.project_tasks t on t.id = d.task_id
  join public.projects      p on p.id = t.project_id
  where d.id = p_deliverable_id;

  return v_result;
end;
$function$;


-- =========================================================================================
-- 02 · release_deliverable_qa — devolver el turno sin veredicto
-- =========================================================================================
-- Cuando la IA no responde, el entregable NO se rechaza: se deja en 'error'. Rechazar a un
-- proveedor porque se cayó un proveedor de modelos sería castigarlo por nuestra
-- infraestructura, y 'error' es además uno de los estados en los que la RLS le permite
-- volver a editar y reintentar.
create or replace function public.release_deliverable_qa(
  p_deliverable_id uuid,
  p_status         public.qa_status default 'error',
  p_error          text default null
)
returns boolean
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_rows integer;
begin
  update public.deliverables d
     set qa_status  = p_status,
         qa_feedback = case
           when p_error is null then d.qa_feedback
           else d.qa_feedback || jsonb_build_object(
             'last_error', p_error,
             'last_error_at', to_jsonb(now())
           )
         end,
         updated_at = now()
   where d.id = p_deliverable_id
     and d.qa_status = 'running';

  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$function$;


-- =========================================================================================
-- 03 · apply_qa_verdict — el veredicto entero, en una transacción
-- =========================================================================================
-- Escribe cinco cosas que deben ocurrir juntas o no ocurrir: el veredicto en el entregable,
-- la reseña automática, los eventos de reputación, el estado de la tarea y —vía el trigger
-- `trg_propagate_task_readiness` de la 0002— el desbloqueo de las tareas que dependían de
-- ella. Hacerlo desde el cliente serían cinco viajes sin transacción: un fallo a mitad
-- dejaría una tarea aprobada sin reseña, o reputación cobrada por trabajo no aprobado.
--
-- `p_reputation` es un array de {event_type, delta, weight, reason}. Los importes los decide
-- `lib/qa/policy.ts`: son política, no esquema.
create or replace function public.apply_qa_verdict(
  p_deliverable_id      uuid,
  p_qa_status           public.qa_status,
  p_qa_score            numeric,
  p_qa_feedback         jsonb,
  p_qa_criteria_results jsonb,
  p_task_status         public.task_status,
  p_rating              numeric,
  p_qa_run_id           uuid    default null,
  p_quality_score       numeric default null,
  p_timeliness_score    numeric default null,
  p_comment             text    default null,
  p_reputation          jsonb   default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_task_id      uuid;
  v_provider_id  uuid;
  v_review_id    uuid;
  v_event        jsonb;
  v_event_type   public.reputation_event_type;
  v_written      integer := 0;
  v_skipped      text[]  := array[]::text[];
begin
  if p_qa_status not in ('approved', 'rejected', 'revision_requested') then
    raise exception 'VEKTORA/QA: apply_qa_verdict no admite qa_status=%', p_qa_status
      using errcode = '22023';
  end if;

  -- Solo se aplica sobre un turno realmente tomado. Si otro proceso ya resolvió este
  -- entregable, aquí no se pisa nada: se informa y se sale.
  update public.deliverables d
     set qa_status           = p_qa_status,
         qa_score            = p_qa_score,
         qa_feedback         = coalesce(p_qa_feedback, '{}'::jsonb),
         qa_criteria_results = coalesce(p_qa_criteria_results, '[]'::jsonb),
         qa_run_id           = p_qa_run_id,
         qa_evaluated_at     = now(),
         updated_at          = now()
   where d.id = p_deliverable_id
     and d.qa_status = 'running'
  returning d.task_id, d.provider_id into v_task_id, v_provider_id;

  if v_task_id is null then
    return jsonb_build_object(
      'applied', false,
      'reason', 'el entregable no estaba en qa_status=running: otro proceso lo resolvió antes'
    );
  end if;

  -- --- Reseña automática ---------------------------------------------------------------
  -- `reviewer_id` nulo es la firma del juez automático, y el índice único parcial
  -- `reviews_unique_machine` garantiza UNA sola por (tarea, evaluado, fuente). Reevaluar un
  -- entregable posterior de la misma tarea ACTUALIZA esa reseña en vez de acumular otra.
  insert into public.reviews (
    task_id, deliverable_id, reviewer_id, reviewee_id, source,
    rating, quality_score, timeliness_score, comment, is_public
  )
  values (
    v_task_id, p_deliverable_id, null, v_provider_id, 'ai_judge',
    p_rating, p_quality_score, p_timeliness_score, p_comment, true
  )
  on conflict (task_id, reviewee_id, source) where reviewer_id is null
  do update set
    deliverable_id   = excluded.deliverable_id,
    rating           = excluded.rating,
    quality_score    = excluded.quality_score,
    timeliness_score = excluded.timeliness_score,
    comment          = excluded.comment,
    updated_at       = now()
  returning id into v_review_id;

  -- --- Reputación ----------------------------------------------------------------------
  -- Guardia de idempotencia ANTES del insert, porque después no hay vuelta atrás: la tabla
  -- es append-only y ni siquiera un superusuario puede corregir la fila.
  for v_event in select * from jsonb_array_elements(coalesce(p_reputation, '[]'::jsonb))
  loop
    v_event_type := (v_event ->> 'event_type')::public.reputation_event_type;

    if exists (
      select 1
        from public.reputation_events re
       where re.deliverable_id = p_deliverable_id
         and re.event_type = v_event_type
    ) then
      v_skipped := v_skipped || v_event_type::text;
      continue;
    end if;

    insert into public.reputation_events (
      user_id, event_type, delta, weight, reason,
      task_id, deliverable_id, review_id, actor_type, metadata
    )
    values (
      v_provider_id,
      v_event_type,
      coalesce((v_event ->> 'delta')::numeric, 0),
      coalesce((v_event ->> 'weight')::numeric, 1),
      v_event ->> 'reason',
      v_task_id,
      p_deliverable_id,
      v_review_id,
      'ai_agent',
      coalesce(v_event -> 'metadata', '{}'::jsonb)
    );
    v_written := v_written + 1;
  end loop;

  -- --- Estado de la tarea --------------------------------------------------------------
  -- Pasar a 'approved' dispara `trg_propagate_task_readiness`, que recalcula qué tareas
  -- aguas abajo quedan listas. Ahí es donde el DAG avanza solo.
  update public.project_tasks t
     set status     = p_task_status,
         updated_at = now()
   where t.id = v_task_id
     and t.status is distinct from p_task_status;

  return jsonb_build_object(
    'applied',             true,
    'deliverable_id',      p_deliverable_id,
    'task_id',             v_task_id,
    'provider_id',         v_provider_id,
    'review_id',           v_review_id,
    'qa_status',           p_qa_status,
    'task_status',         p_task_status,
    'reputation_written',  v_written,
    'reputation_skipped',  to_jsonb(v_skipped)
  );
end;
$function$;


-- =========================================================================================
-- 04 · pending_qa_deliverables — la cola del juez
-- =========================================================================================
-- Más antiguo primero: sin orden estable, un entregable desafortunado podría esperar para
-- siempre mientras llegan otros. Usa `idx_deliverables_pending` (parcial sobre
-- submitted_at where qa_status in ('pending','running')).
create or replace function public.pending_qa_deliverables(p_limit integer default 20)
returns table (
  deliverable_id uuid,
  task_id        uuid,
  project_id     uuid,
  task_code      text,
  task_title     text,
  provider_id    uuid,
  version        integer,
  qa_status      public.qa_status,
  submitted_at   timestamptz,
  criteria_count integer
)
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  select
    d.id,
    d.task_id,
    t.project_id,
    t.code,
    t.title,
    d.provider_id,
    d.version,
    d.qa_status,
    d.submitted_at,
    coalesce(jsonb_array_length(t.acceptance_criteria), 0)::integer
  from public.deliverables d
  join public.project_tasks t on t.id = d.task_id
  where d.qa_status in ('pending', 'revision_requested', 'error')
  order by d.submitted_at asc
  limit greatest(1, coalesce(p_limit, 20));
$function$;


-- =========================================================================================
-- 05 · Privilegios
-- =========================================================================================
-- PostgreSQL concede EXECUTE a PUBLIC en cada función nueva, así que `revoke ... from anon`
-- no basta: hay que revocar a PUBLIC y luego conceder explícitamente. Estas cuatro las
-- ejecuta el juez con `service_role`, que no necesita GRANT porque bypassea RLS; ningún
-- rol de cliente debe poder emitir un veredicto ni mover reputación.
do $$
declare
  v_fn text;
begin
  foreach v_fn in array array[
    'public.claim_deliverable_for_qa(uuid)',
    'public.release_deliverable_qa(uuid, public.qa_status, text)',
    'public.apply_qa_verdict(uuid, public.qa_status, numeric, jsonb, jsonb, public.task_status, numeric, uuid, numeric, numeric, text, jsonb)',
    'public.pending_qa_deliverables(integer)'
  ]
  loop
    execute format('revoke all on function %s from public', v_fn);
    execute format('revoke all on function %s from anon, authenticated', v_fn);
  end loop;
end $$;
