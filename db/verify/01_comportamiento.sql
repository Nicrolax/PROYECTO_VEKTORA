-- =====================================================================================
-- VEKTORA — Verificación de comportamiento de la capa de datos
-- =====================================================================================
-- Se ejecuta sobre una base LOCAL desechable, nunca contra Supabase: crea proyectos,
-- usuarios y skills de prueba.
--
--   psql ... -f db/verify/00_harness.sql
--   psql ... -f db/schema.sql
--   psql ... -f db/migrations/0002_planner.sql
--   psql ... -f db/migrations/0003_provider_onboarding.sql
--   psql ... -f db/seeds/01_skills.sql
--   psql ... -f db/verify/01_comportamiento.sql
--   psql ... -f db/verify/02_rls.sql
--
-- Ver db/verify/LEEME.md.
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

\echo '=== 1. Bootstrap auth.users -> public.users + profiles'
insert into auth.users (id, email, raw_user_meta_data) values
  ('11111111-1111-1111-1111-111111111111', 'cliente@vektora.test', '{"full_name":"Clienta Uno"}'),
  ('22222222-2222-2222-2222-222222222222', 'prove@vektora.test',   '{"full_name":"Proveedora Dos"}'),
  ('33333333-3333-3333-3333-333333333333', 'tercero@vektora.test', '{}');
select count(*) as usuarios, (select count(*) from public.profiles) as perfiles,
       (select full_name from public.profiles where user_id='11111111-1111-1111-1111-111111111111') as nombre
from public.users;

\echo '=== 2. Proyecto + apply_project_plan (diamante, presupuesto 3000)'
insert into public.projects (id, owner_id, title, objective, budget_total, status)
values ('aaaaaaaa-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111',
        'Micrositio de captación','Necesito un micrositio de captación con formulario y analítica',3000,'planning');

select jsonb_pretty(public.apply_project_plan(
  'aaaaaaaa-0000-0000-0000-000000000001',
  '[{"code":"T-01","title":"Base tecnica","estimated_hours":4,"budget":1200,"order_index":1,"depth":0,"status":"ready","required_skills":["nextjs"]},
    {"code":"T-02","title":"Contenido","estimated_hours":6,"budget":900,"order_index":2,"depth":1,"status":"blocked","required_skills":["copywriting"]},
    {"code":"T-03","title":"Analitica","estimated_hours":10,"budget":600,"order_index":3,"depth":1,"status":"blocked","required_skills":["seo"]},
    {"code":"T-04","title":"Cierre","estimated_hours":2,"budget":300,"order_index":4,"depth":2,"status":"blocked","required_skills":["qa-testing"]}]'::jsonb,
  '[{"task_code":"T-02","depends_on_code":"T-01"},{"task_code":"T-03","depends_on_code":"T-01"},
    {"task_code":"T-04","depends_on_code":"T-02"},{"task_code":"T-04","depends_on_code":"T-03"}]'::jsonb,
  '{"title":"Micrositio de captacion con analitica","planner_version":3}'::jsonb
)) as resultado;

select sum(budget) as suma_presupuestos, count(*) as tareas from public.project_tasks
where project_id='aaaaaaaa-0000-0000-0000-000000000001';
select title, status from public.projects where id='aaaaaaaa-0000-0000-0000-000000000001';

\echo '=== 3. El trigger rechaza un ciclo (se espera SQLSTATE 23514)'
do $$
declare v_t1 uuid; v_t2 uuid;
begin
  select id into v_t1 from public.project_tasks where code='T-01' and project_id='aaaaaaaa-0000-0000-0000-000000000001';
  select id into v_t2 from public.project_tasks where code='T-04' and project_id='aaaaaaaa-0000-0000-0000-000000000001';
  begin
    insert into public.task_dependencies (task_id, depends_on_task_id) values (v_t1, v_t2);
    raise warning 'FALLO: el ciclo NO fue rechazado';
  exception when check_violation then
    raise notice 'OK ciclo rechazado -> %', sqlerrm;
  end;
end $$;

\echo '=== 4. refresh_task_readiness: aprobar T-01 desbloquea T-02 y T-03, T-04 sigue bloqueada'
update public.project_tasks set status='approved'
where code='T-01' and project_id='aaaaaaaa-0000-0000-0000-000000000001';
select code, status from public.project_tasks
where project_id='aaaaaaaa-0000-0000-0000-000000000001' order by code;

\echo '=== 5. normalize_skill_slug'
select public.normalize_skill_slug('React 18') as a,
       public.normalize_skill_slug('  NEXT.js  ') as b,
       public.normalize_skill_slug('---') as c;

\echo '=== 6. Catalogo vectorizado (sintetico) y resolve_or_create_skill'
update public.skills set embedding = pg_temp.onehot(1), embedding_model='test' where slug='react';
update public.skills set embedding = pg_temp.onehot(2), embedding_model='test' where slug='python';
update public.skills set embedding = pg_temp.onehot(3), embedding_model='test' where slug='seo';

select 'exacta'   as caso, public.resolve_or_create_skill('React')                      ->> 'match' as match,
       public.resolve_or_create_skill('React') ->> 'slug' as slug
union all
select 'semantica', r ->> 'match', r ->> 'slug' from (
  select public.resolve_or_create_skill('reactjs', 'React JS', pg_temp.mix(1, 0.99, 2, 0.14)::text) as r) x
union all
select 'alias(2a vez)', r ->> 'match', r ->> 'slug' from (
  select public.resolve_or_create_skill('reactjs') as r) y
union all
select 'creada', r ->> 'match', r ->> 'slug' from (
  select public.resolve_or_create_skill('soldadura tig', 'Soldadura TIG', pg_temp.onehot(900)::text) as r) z;

select alias, similarity from public.skill_aliases;

\echo '=== 7. Alta de proveedor'
select public.upsert_provider_profile(
  '22222222-2222-2222-2222-222222222222',
  '{"headline":"Ingeniera front-end","summary":"React y Next.js","hourly_rate_usd":55,"languages":["es","en"]}'::jsonb
) as provider_profile_id \gset
select public.set_provider_skills(:'provider_profile_id',
  (select jsonb_agg(jsonb_build_object('skill_id', id, 'level', 4)) from public.skills where slug in ('react','nextjs'))
) as skills_vinculadas;
-- Actualización parcial: NO debe borrar headline ni languages
select public.upsert_provider_profile('22222222-2222-2222-2222-222222222222','{"seniority":"senior"}'::jsonb);
select headline, seniority, hourly_rate_usd, languages from public.provider_profiles
where user_id='22222222-2222-2222-2222-222222222222';

-- El aislamiento por RLS se verifica aparte, en 02_rls.sql: exige transacciones
-- explícitas (SET LOCAL fuera de una transacción no aplica y la prueba no probaría nada).

\echo '=== 9. anon NO puede invocar apply_project_plan'
do $$
begin
  if has_function_privilege('anon', 'public.apply_project_plan(uuid,jsonb,jsonb,jsonb)', 'EXECUTE') then
    raise warning 'FALLO: anon tiene EXECUTE sobre apply_project_plan';
  else
    raise notice 'OK anon sin EXECUTE sobre apply_project_plan';
  end if;
  if has_function_privilege('anon', 'public.is_admin()', 'EXECUTE') then
    raise notice 'OK anon conserva EXECUTE sobre is_admin (lo exige skills_select_all)';
  else
    raise warning 'FALLO: anon sin is_admin -> se rompe la lectura de skills';
  end if;
end $$;

\echo '=== 10. anon puede leer el catalogo de skills (regresion de la FASE 3)'
set local role anon;
select count(*) as skills_visibles_anon from public.skills;
reset role;
