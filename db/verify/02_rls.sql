\set ON_ERROR_STOP on
\pset pager off

\echo '--- tercero (no es dueño ni asignado ni postulante)'
begin;
  set local role authenticated;
  set local "request.jwt.claim.sub" = '33333333-3333-3333-3333-333333333333';
  select count(*) as proyectos_visibles from public.projects;
  select count(*) as tareas_visibles    from public.project_tasks;
  select count(*) as aristas_visibles   from public.task_dependencies;
commit;

\echo '--- dueño del proyecto'
begin;
  set local role authenticated;
  set local "request.jwt.claim.sub" = '11111111-1111-1111-1111-111111111111';
  select count(*) as proyectos_visibles from public.projects;
  select count(*) as tareas_visibles    from public.project_tasks;
  select count(*) as aristas_visibles   from public.task_dependencies;
commit;

\echo '--- el tercero NO puede escribir en el proyecto ajeno'
begin;
  set local role authenticated;
  set local "request.jwt.claim.sub" = '33333333-3333-3333-3333-333333333333';
  do $$
  begin
    update public.projects set title = 'secuestrado'
     where id = 'aaaaaaaa-0000-0000-0000-000000000001';
    if found then raise warning 'FALLO: un tercero modifico el proyecto ajeno';
    else raise notice 'OK RLS bloqueo el UPDATE del tercero (0 filas afectadas)'; end if;
  end $$;
rollback;

\echo '--- el tercero NO puede plantar un plan (apply_project_plan es SECURITY INVOKER)'
begin;
  set local role authenticated;
  set local "request.jwt.claim.sub" = '33333333-3333-3333-3333-333333333333';
  do $$
  begin
    perform public.apply_project_plan(
      'aaaaaaaa-0000-0000-0000-000000000001',
      '[{"code":"T-99","title":"Intruso"}]'::jsonb);
    raise warning 'FALLO: un tercero aplico un plan en proyecto ajeno';
  exception when insufficient_privilege then
    raise notice 'OK apply_project_plan rechazo al tercero -> %', sqlerrm;
  end $$;
rollback;

\echo '--- un usuario NO puede escalar su propio rol a admin'
begin;
  set local role authenticated;
  set local "request.jwt.claim.sub" = '33333333-3333-3333-3333-333333333333';
  do $$
  begin
    update public.users set role = 'admin' where id = '33333333-3333-3333-3333-333333333333';
    raise warning 'FALLO: escalada de rol permitida';
  exception when insufficient_privilege then
    raise notice 'OK escalada de rol bloqueada -> %', sqlerrm;
  end $$;
rollback;

\echo '--- reputation_events es append-only'
begin;
  insert into public.reputation_events (user_id, event_type, delta)
  values ('22222222-2222-2222-2222-222222222222', 'onboarding_bonus', 5);
  select reputation_score from public.provider_profiles
   where user_id = '22222222-2222-2222-2222-222222222222';
  do $$
  begin
    update public.reputation_events set delta = 100;
    raise warning 'FALLO: reputation_events resulto mutable';
  exception when insufficient_privilege then
    raise notice 'OK reputation_events es append-only -> %', sqlerrm;
  end $$;
rollback;

\echo '--- un proveedor NO puede tocar el perfil de otro'
begin;
  set local role authenticated;
  set local "request.jwt.claim.sub" = '33333333-3333-3333-3333-333333333333';
  do $$
  begin
    perform public.upsert_provider_profile(
      '22222222-2222-2222-2222-222222222222', '{"headline":"secuestrado"}'::jsonb);
    raise warning 'FALLO: un tercero modifico el perfil de otro proveedor';
  exception when insufficient_privilege then
    raise notice 'OK upsert_provider_profile rechazo al tercero';
  end $$;
rollback;
