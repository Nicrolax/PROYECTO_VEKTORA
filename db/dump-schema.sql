-- =====================================================================================
-- VEKTORA — Volcado del esquema REAL desplegado
-- =====================================================================================
-- Solo lectura: consulta catálogos del sistema, no modifica nada.
--
-- Pegar entero en el SQL Editor, ejecutar, y copiar el contenido de la única celda del
-- resultado (clic en la celda -> se expande -> Ctrl+A, Ctrl+C).
--
-- Con esto se reconstruyen db/schema.sql y db/migrations/0002_planner.sql calcados de lo
-- que de verdad hay en la base, en vez de deducidos de la documentación.
-- =====================================================================================

with columnas as (
  select string_agg(
    format('%s.%s : %s%s%s',
      c.table_name,
      c.column_name,
      c.data_type
        || coalesce('(' || c.character_maximum_length || ')', '')
        || coalesce('(' || c.numeric_precision || ',' || c.numeric_scale || ')', ''),
      case when c.is_nullable = 'NO' then ' NOT NULL' else '' end,
      coalesce(' DEFAULT ' || c.column_default, '')
    ),
    E'\n' order by c.table_name, c.ordinal_position
  ) as texto
  from information_schema.columns c
  join information_schema.tables t
    on t.table_schema = c.table_schema and t.table_name = c.table_name
  where c.table_schema = 'public' and t.table_type = 'BASE TABLE'
),
tipos as (
  select string_agg(
    format('%s = %s', t.typname, (
      select string_agg(quote_literal(e.enumlabel), ', ' order by e.enumsortorder)
      from pg_enum e where e.enumtypid = t.oid
    )),
    E'\n' order by t.typname
  ) as texto
  from pg_type t
  join pg_namespace n on n.oid = t.typnamespace
  where n.nspname = 'public' and t.typtype = 'e'
),
restricciones as (
  select string_agg(
    format('%s : %s : %s', rel.relname, con.conname, pg_get_constraintdef(con.oid)),
    E'\n' order by rel.relname, con.conname
  ) as texto
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  join pg_namespace n on n.oid = rel.relnamespace
  where n.nspname = 'public'
),
indices as (
  select string_agg(indexdef, E'\n' order by indexname) as texto
  from pg_indexes where schemaname = 'public'
),
politicas as (
  select string_agg(
    format('%s : %s : %s : roles=%s : USING(%s) : CHECK(%s)',
      tablename, policyname, cmd, roles::text,
      coalesce(qual, '-'), coalesce(with_check, '-')),
    E'\n' order by tablename, policyname
  ) as texto
  from pg_policies where schemaname = 'public'
),
funciones as (
  select string_agg(
    format(E'-- %s\n%s;', p.proname, pg_get_functiondef(p.oid)),
    E'\n\n' order by p.proname
  ) as texto
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prokind in ('f', 'p')
),
vistas as (
  select string_agg(format(E'-- %s\n%s', viewname, definition), E'\n\n' order by viewname) as texto
  from pg_views where schemaname = 'public'
),
disparadores as (
  select string_agg(
    format('%s : %s', c.relname, pg_get_triggerdef(tg.oid)),
    E'\n' order by c.relname, tg.tgname
  ) as texto
  from pg_trigger tg
  join pg_class c on c.oid = tg.tgrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and not tg.tgisinternal
)
select
  E'=== ENUMS ===\n'        || coalesce((select texto from tipos), '(ninguno)')         ||
  E'\n\n=== COLUMNAS ===\n' || coalesce((select texto from columnas), '(ninguna)')      ||
  E'\n\n=== RESTRICCIONES ===\n' || coalesce((select texto from restricciones), '(ninguna)') ||
  E'\n\n=== INDICES ===\n'  || coalesce((select texto from indices), '(ninguno)')       ||
  E'\n\n=== POLITICAS RLS ===\n' || coalesce((select texto from politicas), '(ninguna)') ||
  E'\n\n=== TRIGGERS ===\n' || coalesce((select texto from disparadores), '(ninguno)')  ||
  E'\n\n=== VISTAS ===\n'   || coalesce((select texto from vistas), '(ninguna)')        ||
  E'\n\n=== FUNCIONES ===\n'|| coalesce((select texto from funciones), '(ninguna)')
  as esquema_real;
