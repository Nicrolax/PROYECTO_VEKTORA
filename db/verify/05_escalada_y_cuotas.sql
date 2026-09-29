-- =====================================================================================
-- VEKTORA · FASE 7 — Verificación de la escalada y de las cuotas
-- =====================================================================================
-- Sobre base LOCAL desechable. Requiere 00_harness + schema + 0002..0007.
-- =====================================================================================
\set ON_ERROR_STOP on
\pset pager off
set search_path = public, extensions;

\echo '=== Preparación'
insert into auth.users (id, email) values
  ('11110000-0000-0000-0000-000000000001', 'cliente@cuota.test'),
  ('11110000-0000-0000-0000-000000000002', 'otro@cuota.test');

insert into public.projects (id, owner_id, title, objective, budget_total, status)
values ('22220000-0000-0000-0000-000000000001','11110000-0000-0000-0000-000000000001',
        'Proyecto cuota','Objetivo de prueba para cuotas y escalada', 500, 'planned');

insert into public.project_tasks (id, project_id, code, title, description,
       required_skills, estimated_hours, budget, status)
values ('33330000-0000-0000-0000-000000000001','22220000-0000-0000-0000-000000000001',
        'T-01','Tarea que nadie quiere','Descripción', array['seo'], 5, 100, 'ready');

\echo ''
\echo '=== 1. Las rondas arrancan en cero y se incrementan'
select matching_rounds as al_empezar from public.project_tasks
 where id='33330000-0000-0000-0000-000000000001';
select public.bump_matching_round('33330000-0000-0000-0000-000000000001') as ronda_1;
select public.bump_matching_round('33330000-0000-0000-0000-000000000001') as ronda_2;
select public.bump_matching_round('33330000-0000-0000-0000-000000000001') as ronda_3;

\echo ''
\echo '=== 2. Al adjudicarse, el contador vuelve a cero'
update public.project_tasks
   set assignee_id = '11110000-0000-0000-0000-000000000002', status = 'assigned'
 where id='33330000-0000-0000-0000-000000000001';
select matching_rounds as tras_adjudicar from public.project_tasks
 where id='33330000-0000-0000-0000-000000000001';
\echo '--> 0: si la tarea se reabre, el mercado arranca en igualdad de condiciones'

\echo ''
\echo '=== 3. Una tarea YA adjudicada no acumula rondas'
select public.bump_matching_round('33330000-0000-0000-0000-000000000001') as ronda_sobre_adjudicada;
\echo '--> 0: el emparejador no la vuelve a contar'

\echo ''
\echo '=== 4. La cuota permite hasta el límite y después corta'
select
  (public.consume_quota('11110000-0000-0000-0000-000000000001','crear_proyecto',3,24) ->> 'permitido')::boolean as uso_1,
  (public.consume_quota('11110000-0000-0000-0000-000000000001','crear_proyecto',3,24) ->> 'permitido')::boolean as uso_2,
  (public.consume_quota('11110000-0000-0000-0000-000000000001','crear_proyecto',3,24) ->> 'permitido')::boolean as uso_3,
  (public.consume_quota('11110000-0000-0000-0000-000000000001','crear_proyecto',3,24) ->> 'permitido')::boolean as uso_4;
\echo '--> t, t, t, f'

\echo ''
\echo '=== 5. El rechazo dice cuándo se libera el siguiente hueco'
select jsonb_pretty(public.consume_quota('11110000-0000-0000-0000-000000000001','crear_proyecto',3,24));

\echo ''
\echo '=== 6. La cuota es POR USUARIO: otro empieza de cero'
select (public.consume_quota('11110000-0000-0000-0000-000000000002','crear_proyecto',3,24) ->> 'permitido')::boolean as otro_usuario;

\echo ''
\echo '=== 7. La cuota es POR ACCIÓN: agotar una no agota las demás'
select (public.consume_quota('11110000-0000-0000-0000-000000000001','entregar',3,24) ->> 'permitido')::boolean as otra_accion;

\echo ''
\echo '=== 8. Un rechazo NO consume hueco'
select public.quota_usage('11110000-0000-0000-0000-000000000001','crear_proyecto',24) as usados_tras_rechazos;
\echo '--> 3, no 5: los intentos rechazados no se registran'

\echo ''
\echo '=== 9. Una ventana que ya pasó no cuenta'
update public.usage_events set created_at = now() - interval '48 hours'
 where user_id='11110000-0000-0000-0000-000000000001' and action='crear_proyecto';
select public.quota_usage('11110000-0000-0000-0000-000000000001','crear_proyecto',24) as en_ventana_de_24h;
select (public.consume_quota('11110000-0000-0000-0000-000000000001','crear_proyecto',3,24) ->> 'permitido')::boolean as vuelve_a_permitir;

\echo ''
\echo '=== 10. Límite cero deshabilita la acción, no la abre'
select jsonb_pretty(public.consume_quota('11110000-0000-0000-0000-000000000002','peligrosa',0,24));

\echo ''
\echo '=== 11. anon y authenticated no pueden fabricarse cuota'
select
  has_function_privilege('anon','public.consume_quota(uuid, text, integer, numeric)','EXECUTE') as anon,
  has_function_privilege('authenticated','public.consume_quota(uuid, text, integer, numeric)','EXECUTE') as authenticated,
  has_function_privilege('anon','public.bump_matching_round(uuid)','EXECUTE') as anon_rondas;
\echo '--> los tres f'

\echo ''
\echo '=== FASE 7 verificada ==='
