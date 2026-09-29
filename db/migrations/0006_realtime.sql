-- =========================================================================================
-- VEKTORA · FASE 6 — Publicación de cambios en vivo
-- =========================================================================================
-- Depende de: db/schema.sql
-- Idempotente: se puede reaplicar sobre una base ya desplegada.
--
-- Supabase Realtime solo emite cambios de las tablas incluidas en la publicación
-- `supabase_realtime`. Sin esto, el visualizador del grafo se suscribe correctamente, no da
-- ningún error, y sencillamente no se entera de nada: el peor modo de fallo posible, porque
-- parece funcionar.
--
-- Solo se publican las tres tablas cuyo cambio de estado tiene que verse sin recargar. No se
-- publican `deliverables` ni `reviews`: su contenido puede ser extenso y el canal en vivo no
-- aplica las políticas de acceso por fila con la misma granularidad que una consulta. La
-- interfaz usa la notificación como señal para volver a pedir los datos al servidor, donde
-- sí pasan por las políticas, en lugar de recibirlos por el canal.
-- =========================================================================================

do $$
declare
  v_tabla text;
begin
  foreach v_tabla in array array['project_tasks', 'task_applications', 'projects']
  loop
    if not exists (
      select 1
        from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = v_tabla
    ) then
      execute format('alter publication supabase_realtime add table public.%I', v_tabla);
      raise notice 'VEKTORA: % añadida a supabase_realtime', v_tabla;
    else
      raise notice 'VEKTORA: % ya estaba publicada', v_tabla;
    end if;
  end loop;
exception
  -- En una base local de verificación no existe la publicación de Supabase. No es un error:
  -- el canal en vivo es una mejora de la interfaz, no un requisito del modelo de datos.
  when undefined_object then
    raise notice 'VEKTORA: no existe la publicación supabase_realtime (¿base local?); se omite';
end $$;

-- `replica identity full` hace que las notificaciones de UPDATE incluyan los valores
-- ANTERIORES además de los nuevos. La interfaz lo necesita para distinguir un cambio de
-- estado real de una escritura que no movió nada.
alter table public.project_tasks replica identity full;
