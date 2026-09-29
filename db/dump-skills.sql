-- =====================================================================================
-- VEKTORA — Genera el seed del catálogo de skills desde la base desplegada
-- =====================================================================================
-- Solo lectura. Devuelve UNA celda con el INSERT listo para pegar en
-- db/seeds/01_skills.sql, de modo que un despliegue nuevo arranque con el mismo
-- vocabulario que el actual.
--
-- Se excluyen las de categoría 'auto': esas las crea sola `register_skills` a partir de
-- lo que pida el planificador, y no son parte del catálogo semilla.
-- =====================================================================================

select
  E'insert into public.skills (slug, name, category, description) values\n'
  || string_agg(
       format('  (%L, %L, %L, %L)',
              s.slug::text, s.name, s.category, coalesce(s.description, '')),
       E',\n' order by s.category nulls last, s.slug
     )
  || E'\non conflict (slug) do update\n'
  || E'  set name        = excluded.name,\n'
  || E'      category    = excluded.category,\n'
  || E'      description = excluded.description;\n'
  as seed_sql
from public.skills s
where s.is_active
  and coalesce(s.category, '') <> 'auto';
