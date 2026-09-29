-- =====================================================================================
-- VEKTORA — Diagnóstico de la base desplegada
-- =====================================================================================
-- Solo lee catálogos del sistema: no escribe ni modifica nada.
-- Pegar entero en el SQL Editor, ejecutar y compartir la tabla resultante.
-- =====================================================================================

select
  t.table_name,
  (
    select count(*)
    from information_schema.columns c
    where c.table_schema = 'public' and c.table_name = t.table_name
  ) as columnas,
  (
    select string_agg(c.column_name, ', ' order by c.ordinal_position)
    from information_schema.columns c
    where c.table_schema = 'public' and c.table_name = t.table_name
  ) as lista_de_columnas
from (
  values
    ('users'), ('profiles'), ('provider_profiles'), ('skills'), ('provider_skills'),
    ('projects'), ('project_tasks'), ('task_dependencies'), ('task_applications'),
    ('deliverables'), ('reviews'), ('reputation_events'), ('ai_runs'), ('audit_logs')
) as t(table_name)
order by t.table_name;
