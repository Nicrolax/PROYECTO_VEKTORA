-- =====================================================================================
-- VEKTORA · FASE 4 — Verificación de comportamiento del motor de matching
-- =====================================================================================
-- Sobre base LOCAL desechable. Requiere 00_harness + schema + 0002 + 0003 + seeds + 0004.
-- =====================================================================================
\set ON_ERROR_STOP on
\pset pager off
set search_path = public, extensions;

create or replace function pg_temp.onehot(p_index int, p_weight float8 default 1)
returns vector(1536) language sql immutable as $$
  select ('[' || string_agg(case when g = p_index then p_weight::text else '0' end, ',') || ']')::vector(1536)
  from generate_series(1, 1536) g;
$$;
create or replace function pg_temp.mix(a int, wa float8, b int, wb float8)
returns vector(1536) language sql immutable as $$
  select ('[' || string_agg(
      case when g = a then wa::text when g = b then wb::text else '0' end, ',') || ']')::vector(1536)
  from generate_series(1, 1536) g;
$$;

\echo '=== Preparación: 1 cliente + 4 proveedores'
insert into auth.users (id, email) values
  ('aaaa0000-0000-0000-0000-000000000001', 'cliente@match.test'),
  ('bbbb0000-0000-0000-0000-000000000001', 'afin@match.test'),
  ('bbbb0000-0000-0000-0000-000000000002', 'lejano@match.test'),
  ('bbbb0000-0000-0000-0000-000000000003', 'caro@match.test'),
  ('bbbb0000-0000-0000-0000-000000000004', 'manual@match.test');

-- El proveedor "afín" comparte dirección vectorial con la tarea; el "lejano" no.
insert into public.provider_profiles (user_id, headline, embedding, embedding_model,
       reputation_score, min_task_budget_usd, accepts_auto_assign, is_active)
values
  ('bbbb0000-0000-0000-0000-000000000001', 'Afín',   pg_temp.onehot(1),            'test', 120, null,  true,  true),
  ('bbbb0000-0000-0000-0000-000000000002', 'Lejano', pg_temp.onehot(900),          'test',  10, null,  true,  true),
  ('bbbb0000-0000-0000-0000-000000000003', 'Caro',   pg_temp.mix(1, 0.98, 2, 0.2), 'test',  80, 99999, true,  true),
  ('bbbb0000-0000-0000-0000-000000000004', 'Manual', pg_temp.mix(1, 0.97, 2, 0.24),'test',  90, null,  false, true);

-- El dueño del proyecto también es proveedor: no debe aparecer entre sus propios candidatos.
insert into public.provider_profiles (user_id, headline, embedding, embedding_model, is_active)
values ('aaaa0000-0000-0000-0000-000000000001', 'Dueño', pg_temp.onehot(1), 'test', true);

insert into public.provider_skills (provider_profile_id, skill_id, level)
select pp.id, s.id, 5
from public.provider_profiles pp, public.skills s
where pp.user_id in ('bbbb0000-0000-0000-0000-000000000001',
                     'bbbb0000-0000-0000-0000-000000000003',
                     'bbbb0000-0000-0000-0000-000000000004')
  and s.slug in ('react', 'typescript');

-- El "lejano" no tiene NINGUNA de las skills requeridas.
insert into public.provider_skills (provider_profile_id, skill_id, level)
select pp.id, s.id, 5
from public.provider_profiles pp, public.skills s
where pp.user_id = 'bbbb0000-0000-0000-0000-000000000002' and s.slug = 'seo';

insert into public.projects (id, owner_id, title, objective, budget_total, status)
values ('cccc0000-0000-0000-0000-000000000001','aaaa0000-0000-0000-0000-000000000001',
        'Landing de captación','Necesito una landing de captación con formulario', 2000, 'planned');

insert into public.project_tasks (id, project_id, code, title, description, required_skills,
       estimated_hours, budget, status, embedding, embedding_model)
values ('dddd0000-0000-0000-0000-000000000001','cccc0000-0000-0000-0000-000000000001',
        'T-01','Maquetar la landing','Landing responsive', array['react','typescript'],
        8, 500, 'ready', pg_temp.onehot(1), 'test');

\echo '=== 1. match_task_candidates: filtros duros'
select
  pp.headline,
  round(c.vector_similarity, 4) as similitud,
  array_length(c.skill_slugs, 1) as skills
from public.match_task_candidates('dddd0000-0000-0000-0000-000000000001', 20, true) c
join public.provider_profiles pp on pp.id = c.provider_profile_id
order by c.vector_similarity desc nulls last;
\echo '--> se espera: Afín y Lejano. NO el dueño, NO "Caro" (min_task_budget > presupuesto),'
\echo '    NO "Manual" (no acepta asignación automática).'

\echo '=== 2. Con --manual entra también quien no acepta adjudicación automática'
select pp.headline
from public.match_task_candidates('dddd0000-0000-0000-0000-000000000001', 20, false) c
join public.provider_profiles pp on pp.id = c.provider_profile_id
order by pp.headline;

\echo '=== 3. Un proveedor SIN embedding entra igual (rama B)'
insert into auth.users (id, email) values ('bbbb0000-0000-0000-0000-000000000005','sinvector@match.test');
insert into public.provider_profiles (user_id, headline, is_active) values
  ('bbbb0000-0000-0000-0000-000000000005', 'SinVector', true);
insert into public.provider_skills (provider_profile_id, skill_id, level)
select pp.id, s.id, 4 from public.provider_profiles pp, public.skills s
where pp.user_id='bbbb0000-0000-0000-0000-000000000005' and s.slug in ('react','typescript');

select pp.headline, c.vector_similarity is null as sin_vector
from public.match_task_candidates('dddd0000-0000-0000-0000-000000000001', 20, true) c
join public.provider_profiles pp on pp.id = c.provider_profile_id
where pp.headline = 'SinVector';

\echo '=== 4. apply_task_matches escribe el shortlist y mueve la tarea a matching'
select jsonb_pretty(public.apply_task_matches(
  'dddd0000-0000-0000-0000-000000000001',
  jsonb_build_array(
    jsonb_build_object('provider_id','bbbb0000-0000-0000-0000-000000000001',
      'vector_score',0.99,'skill_score',1,'reputation_score',0.8,'match_score',0.92,
      'match_explanation', jsonb_build_object('summary','cubre las 2 skills requeridas')),
    jsonb_build_object('provider_id','bbbb0000-0000-0000-0000-000000000005',
      'vector_score',null,'skill_score',0.8,'reputation_score',0.25,'match_score',0.55,
      'match_explanation', jsonb_build_object('summary','sin similitud semántica disponible'))
  )
));
select status from public.project_tasks where id='dddd0000-0000-0000-0000-000000000001';

\echo '=== 5. Reaplicar refresca la puntuación, NO duplica'
select public.apply_task_matches(
  'dddd0000-0000-0000-0000-000000000001',
  jsonb_build_array(jsonb_build_object('provider_id','bbbb0000-0000-0000-0000-000000000001',
    'vector_score',0.95,'skill_score',1,'reputation_score',0.8,'match_score',0.90,
    'match_explanation','{}'::jsonb))
) -> 'total_applications' as total_tras_reaplicar;
select count(*) as candidaturas from public.task_applications
where task_id='dddd0000-0000-0000-0000-000000000001';
select round(match_score,2) as score_actualizado from public.task_applications
where task_id='dddd0000-0000-0000-0000-000000000001'
  and provider_id='bbbb0000-0000-0000-0000-000000000001';

\echo '=== 6. accept_task_application adjudica y rechaza al resto'
do $$
declare v_app uuid;
begin
  select id into v_app from public.task_applications
   where task_id='dddd0000-0000-0000-0000-000000000001'
     and provider_id='bbbb0000-0000-0000-0000-000000000001';
  perform public.accept_task_application(v_app);
  raise notice 'OK adjudicada';
end $$;

select
  (select status from public.project_tasks where id='dddd0000-0000-0000-0000-000000000001') as tarea,
  (select assignee_id from public.project_tasks where id='dddd0000-0000-0000-0000-000000000001') as asignada_a,
  (select count(*) from public.task_applications
     where task_id='dddd0000-0000-0000-0000-000000000001' and status='accepted') as aceptadas,
  (select count(*) from public.task_applications
     where task_id='dddd0000-0000-0000-0000-000000000001' and status='rejected') as rechazadas;

\echo '=== 7. Una segunda adjudicación falla (la tarea ya tiene dueño)'
do $$
declare v_app uuid;
begin
  select id into v_app from public.task_applications
   where task_id='dddd0000-0000-0000-0000-000000000001' and status='rejected' limit 1;
  begin
    perform public.accept_task_application(v_app);
    raise warning 'FALLO: se adjudicó dos veces la misma tarea';
  exception when unique_violation then
    raise notice 'OK segunda adjudicación rechazada -> %', sqlerrm;
  end;
end $$;

\echo '=== 8. apply_task_matches rechaza una tarea ya asignada'
do $$
begin
  perform public.apply_task_matches('dddd0000-0000-0000-0000-000000000001',
    jsonb_build_array(jsonb_build_object('provider_id','bbbb0000-0000-0000-0000-000000000002',
      'match_score',0.5)));
  raise warning 'FALLO: se escribieron candidaturas sobre una tarea asignada';
exception when others then
  raise notice 'OK rechazado -> %', sqlerrm;
end $$;

\echo '=== 9. Una candidatura RECHAZADA no se reabre en un recálculo'
insert into public.project_tasks (id, project_id, code, title, required_skills, budget, status, embedding, embedding_model)
values ('dddd0000-0000-0000-0000-000000000002','cccc0000-0000-0000-0000-000000000001',
        'T-02','Segunda tarea', array['react'], 400, 'ready', pg_temp.onehot(1), 'test');
insert into public.task_applications (task_id, provider_id, status, match_score)
values ('dddd0000-0000-0000-0000-000000000002','bbbb0000-0000-0000-0000-000000000001','rejected',0.4);
select public.apply_task_matches('dddd0000-0000-0000-0000-000000000002',
  jsonb_build_array(jsonb_build_object('provider_id','bbbb0000-0000-0000-0000-000000000001',
    'match_score',0.95,'match_explanation','{}'::jsonb))) -> 'written' as escritas;
select status, round(match_score,2) as score from public.task_applications
where task_id='dddd0000-0000-0000-0000-000000000002';
\echo '--> se espera escritas=0 y la candidatura sigue rejected con 0.40'

\echo '=== 10. Un candidato con candidatura resuelta no vuelve a proponerse'
select count(*) as veces_propuesto
from public.match_task_candidates('dddd0000-0000-0000-0000-000000000002', 20, true) c
join public.provider_profiles pp on pp.id = c.provider_profile_id
where pp.user_id = 'bbbb0000-0000-0000-0000-000000000001';

\echo '=== 11. skill_similarity_pairs (calibración)'
update public.skills set embedding = pg_temp.onehot(10) where slug='react';
update public.skills set embedding = pg_temp.mix(10, 0.97, 11, 0.24) where slug='nextjs';
update public.skills set embedding = pg_temp.onehot(500) where slug='legal-review';
select slug_a, slug_b, similarity from public.skill_similarity_pairs(0.5, 10);

\echo '=== 12. anon no puede tocar nada del motor'
do $$
begin
  if has_function_privilege('anon','public.apply_task_matches(uuid,jsonb)','EXECUTE')
     or has_function_privilege('anon','public.accept_task_application(uuid)','EXECUTE')
     or has_function_privilege('anon','public.match_task_candidates(uuid,integer,boolean)','EXECUTE')
  then raise warning 'FALLO: anon tiene EXECUTE sobre el motor de matching';
  else raise notice 'OK anon sin acceso al motor de matching';
  end if;
end $$;
