-- =====================================================================================
-- VEKTORA · FASE 5 — Verificación de comportamiento del AI Judge
-- =====================================================================================
-- Sobre base LOCAL desechable. Requiere 00_harness + schema + 0002 + 0003 + seeds + 0004
-- + 0005. Lo que se prueba aquí no es que el SQL aplique, sino que el juez no pueda
-- cobrar dos veces, revocar trabajo ya aprobado, ni castigar a nadie por un fallo de IA.
-- =====================================================================================
\set ON_ERROR_STOP on
\pset pager off
set search_path = public, extensions;

\echo '=== Preparación: proyecto con dos tareas encadenadas y un proveedor'
insert into auth.users (id, email) values
  ('eeee0000-0000-0000-0000-000000000001', 'cliente@qa.test'),
  ('eeee0000-0000-0000-0000-000000000002', 'proveedor@qa.test');

insert into public.provider_profiles (user_id, headline, is_active, reputation_score)
values ('eeee0000-0000-0000-0000-000000000002', 'Proveedor QA', true, 10);

insert into public.projects (id, owner_id, title, objective, budget_total, status)
values ('ffff0000-0000-0000-0000-000000000001','eeee0000-0000-0000-0000-000000000001',
        'Proyecto QA','Objetivo de prueba para el juez automático', 1000, 'active');

-- T-01 asignada y entregada; T-02 depende de T-01 y arranca bloqueada.
insert into public.project_tasks (id, project_id, code, title, description,
       acceptance_criteria, required_skills, estimated_hours, budget, status, assignee_id)
values
  ('ffff0000-0000-0000-0000-000000000011','ffff0000-0000-0000-0000-000000000001',
   'T-01','Redactar el documento de alcance','Alcance del proyecto',
   '[{"id":"AC-1","criterion":"Incluye objetivos medibles","verification":"Se leen los objetivos"},
     {"id":"AC-2","criterion":"Lista lo que queda fuera","verification":"Se busca la sección de exclusiones"}]'::jsonb,
   array['technical-writing'], 8, 300, 'in_progress','eeee0000-0000-0000-0000-000000000002'),
  ('ffff0000-0000-0000-0000-000000000012','ffff0000-0000-0000-0000-000000000001',
   'T-02','Diseñar la arquitectura','Depende del alcance',
   '[{"id":"AC-1","criterion":"Hay un diagrama de componentes","verification":"Se abre el diagrama"}]'::jsonb,
   array['technical-writing'], 8, 300, 'blocked', null);

insert into public.task_dependencies (task_id, depends_on_task_id)
values ('ffff0000-0000-0000-0000-000000000012',
        'ffff0000-0000-0000-0000-000000000011');

insert into public.deliverables (id, task_id, provider_id, summary, content, evidence)
values ('ffff0000-0000-0000-0000-000000000021','ffff0000-0000-0000-0000-000000000011',
        'eeee0000-0000-0000-0000-000000000002','Documento de alcance v1',
        'Objetivos, entregables y exclusiones.',
        '{"AC-1":"Sección 2: tres objetivos con métrica","AC-2":"Sección 5: fuera de alcance"}'::jsonb);


\echo ''
\echo '=== 1. claim_deliverable_for_qa toma el turno y devuelve los criterios'
select
  (c ->> 'claimed')::boolean                                   as tomado,
  c ->> 'previous_status'                                      as estado_previo,
  jsonb_array_length(c -> 'task' -> 'acceptance_criteria')     as criterios,
  (c -> 'previous_rejections')::int                            as rechazos_previos
from public.claim_deliverable_for_qa('ffff0000-0000-0000-0000-000000000021') c;
select qa_status as estado_tras_tomar from public.deliverables
 where id='ffff0000-0000-0000-0000-000000000021';
\echo '--> se espera: tomado=t, estado_previo=pending, criterios=2, estado_tras_tomar=running'

\echo ''
\echo '=== 2. Un segundo juez NO puede tomar el mismo entregable'
select (c ->> 'claimed')::boolean as tomado, c ->> 'reason' as motivo
from public.claim_deliverable_for_qa('ffff0000-0000-0000-0000-000000000021') c;

\echo ''
\echo '=== 3. release_deliverable_qa devuelve el turno como error, no como rechazo'
select public.release_deliverable_qa(
  'ffff0000-0000-0000-0000-000000000021', 'error', 'ambos proveedores agotados') as liberado;
select qa_status, qa_feedback ->> 'last_error' as error_guardado
from public.deliverables where id='ffff0000-0000-0000-0000-000000000021';
\echo '--> un fallo de IA deja el entregable reintentable, NO rechazado'

\echo ''
\echo '=== 4. apply_qa_verdict aprueba: entregable + reseña + reputación + tarea, a la vez'
select (public.claim_deliverable_for_qa('ffff0000-0000-0000-0000-000000000021') ->> 'claimed')::boolean as retomado;
select jsonb_pretty(public.apply_qa_verdict(
  p_deliverable_id      => 'ffff0000-0000-0000-0000-000000000021',
  p_qa_status           => 'approved',
  p_qa_score            => 92.5,
  p_qa_feedback         => '{"summary":"Cumple los dos criterios con evidencia citada"}'::jsonb,
  p_qa_criteria_results => '[{"id":"AC-1","verdict":"pass"},{"id":"AC-2","verdict":"pass"}]'::jsonb,
  p_task_status         => 'approved',
  p_rating              => 4.6,
  p_quality_score       => 4.6,
  p_reputation          => jsonb_build_array(
    jsonb_build_object('event_type','deliverable_approved','delta',8,'weight',1,'reason','QA 92.5'),
    jsonb_build_object('event_type','task_completed','delta',4,'weight',1,'reason','T-01 aprobada'))
));

select qa_status, qa_score, qa_evaluated_at is not null as fechado
from public.deliverables where id='ffff0000-0000-0000-0000-000000000021';
select source, reviewer_id is null as sin_firmante_humano, rating
from public.reviews where task_id='ffff0000-0000-0000-0000-000000000011';
select event_type, delta from public.reputation_events
 where deliverable_id='ffff0000-0000-0000-0000-000000000021' order by event_type;
select reputation_score, tasks_completed from public.provider_profiles
 where user_id='eeee0000-0000-0000-0000-000000000002';
\echo '--> reputación 10 + 8 + 4 = 22, tasks_completed = 1'

\echo ''
\echo '=== 5. El DAG avanza solo: T-02 pasa de blocked a ready por el trigger'
select code, status from public.project_tasks
 where project_id='ffff0000-0000-0000-0000-000000000001' order by code;

\echo ''
\echo '=== 6. Un entregable ya aprobado NO se vuelve a juzgar'
select (c ->> 'claimed')::boolean as tomado, c ->> 'reason' as motivo
from public.claim_deliverable_for_qa('ffff0000-0000-0000-0000-000000000021') c;
\echo '--> el veredicto es terminal: un mal día del modelo no puede revocar trabajo aprobado'

\echo ''
\echo '=== 7. apply_qa_verdict sobre algo que no está running no pisa nada'
select (public.apply_qa_verdict(
  'ffff0000-0000-0000-0000-000000000021', 'rejected', 0,
  '{}'::jsonb, '[]'::jsonb, 'failed', 0) ->> 'applied')::boolean as aplicado;
select qa_status as sigue_aprobado from public.deliverables
 where id='ffff0000-0000-0000-0000-000000000021';

\echo ''
\echo '=== 8. La reputación no se cobra dos veces por el mismo entregable'
-- Se fuerza el estado para poder reaplicar el MISMO veredicto y ver qué hace el guardia.
update public.deliverables set qa_status='running' where id='ffff0000-0000-0000-0000-000000000021';
select
  (v ->> 'reputation_written')::int as eventos_escritos,
  v -> 'reputation_skipped'         as eventos_omitidos
from (select public.apply_qa_verdict(
  p_deliverable_id      => 'ffff0000-0000-0000-0000-000000000021',
  p_qa_status           => 'approved',
  p_qa_score            => 92.5,
  p_qa_feedback         => '{}'::jsonb,
  p_qa_criteria_results => '[]'::jsonb,
  p_task_status         => 'approved',
  p_rating              => 4.6,
  p_reputation          => jsonb_build_array(
    jsonb_build_object('event_type','deliverable_approved','delta',8,'weight',1),
    jsonb_build_object('event_type','task_completed','delta',4,'weight',1))
) as v) s;
select count(*) as eventos_totales from public.reputation_events
 where deliverable_id='ffff0000-0000-0000-0000-000000000021';
select reputation_score as reputacion_sin_inflar from public.provider_profiles
 where user_id='eeee0000-0000-0000-0000-000000000002';
\echo '--> 0 escritos, 2 omitidos, siguen siendo 2 eventos y la reputación sigue en 22'

\echo ''
\echo '=== 9. Una reseña automática por tarea: el segundo entregable ACTUALIZA, no acumula'
insert into public.deliverables (id, task_id, provider_id, summary, content, evidence)
values ('ffff0000-0000-0000-0000-000000000022','ffff0000-0000-0000-0000-000000000011',
        'eeee0000-0000-0000-0000-000000000002','Documento de alcance v2','Revisado',
        '{"AC-1":"ok","AC-2":"ok"}'::jsonb);
select version as version_automatica from public.deliverables
 where id='ffff0000-0000-0000-0000-000000000022';
select (public.claim_deliverable_for_qa('ffff0000-0000-0000-0000-000000000022') ->> 'claimed')::boolean as tomado;
select (public.apply_qa_verdict(
  p_deliverable_id      => 'ffff0000-0000-0000-0000-000000000022',
  p_qa_status           => 'revision_requested',
  p_qa_score            => 55,
  p_qa_feedback         => '{"summary":"AC-2 sin evidencia suficiente"}'::jsonb,
  p_qa_criteria_results => '[{"id":"AC-2","verdict":"fail"}]'::jsonb,
  p_task_status         => 'revision_requested',
  p_rating              => 2.75,
  p_comment             => 'Falta la sección de exclusiones'
) ->> 'applied')::boolean as aplicado;
select count(*) as resenas_automaticas, max(rating) as rating_vigente
from public.reviews
where task_id='ffff0000-0000-0000-0000-000000000011' and reviewer_id is null;
\echo '--> 1 sola reseña, con el rating del ÚLTIMO veredicto'

\echo ''
\echo '=== 10. reputation_events sigue siendo append-only'
do $$
begin
  update public.reputation_events set delta = 100
   where deliverable_id='ffff0000-0000-0000-0000-000000000021';
  raise exception 'FALLO: se pudo modificar el libro mayor';
exception when insufficient_privilege then
  raise notice 'OK: el libro mayor rechazó el UPDATE (%)', sqlerrm;
end $$;

\echo ''
\echo '=== 11. pending_qa_deliverables: cola por antigüedad'
select task_code, qa_status, criteria_count
from public.pending_qa_deliverables(10);

\echo ''
\echo '=== 12. anon y authenticated no pueden emitir veredictos'
select
  has_function_privilege('anon',
    'public.apply_qa_verdict(uuid, public.qa_status, numeric, jsonb, jsonb, public.task_status, numeric, uuid, numeric, numeric, text, jsonb)',
    'EXECUTE') as anon_puede_juzgar,
  has_function_privilege('authenticated',
    'public.claim_deliverable_for_qa(uuid)', 'EXECUTE') as authenticated_puede_tomar;
\echo '--> ambos deben ser f'

\echo ''
\echo '=== FASE 5 verificada ==='
