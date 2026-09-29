-- =====================================================================================
-- VEKTORA — Catálogo semilla de skills (30)
-- =====================================================================================
-- Aplicar DESPUÉS de db/schema.sql y db/migrations/0002_planner.sql.
--
-- El ProjectPlanner recibe este catálogo en el prompt para no inventar slugs. Sin semilla,
-- cada ejecución produciría planes con vocabulario distinto y el matching de la FASE 4 no
-- podría comparar nada: `project_tasks.required_skills` y `provider_skills` tienen que
-- hablar el mismo idioma.
--
-- El catálogo crece solo desde aquí: `register_skills` (FASE 3) da de alta en categoría
-- `auto` lo que el planificador necesite y no exista. Esas NO se versionan en este archivo.
--
-- PROCEDENCIA: extraído de la base desplegada el 2026-09-14 con db/dump-skills.sql.
--
-- No se toca `description`: en la base está vacía y el planificador solo usa `slug` y
-- `category` (ver `renderSkillCatalog` en lib/planner/prompts.ts). Incluirla aquí
-- sobrescribiría datos que alguien podría rellenar más adelante.
-- =====================================================================================

insert into public.skills (slug, name, category) values
  -- --- ai ---------------------------------------------------------------------------
  ('llm-integration',     'Integración de LLMs',      'ai'),
  ('machine-learning',    'Machine Learning',         'ai'),
  ('prompt-engineering',  'Prompt Engineering',       'ai'),
  -- --- business ---------------------------------------------------------------------
  ('financial-modeling',  'Modelado Financiero',      'business'),
  ('legal-review',        'Revisión Legal',           'business'),
  -- --- content ----------------------------------------------------------------------
  ('copywriting',         'Copywriting',              'content'),
  ('technical-writing',   'Redacción Técnica',        'content'),
  ('translation',         'Traducción',               'content'),
  -- --- data -------------------------------------------------------------------------
  ('data-analysis',       'Análisis de Datos',        'data'),
  ('data-engineering',    'Data Engineering',         'data'),
  ('pgvector',            'pgvector / Vector Search', 'data'),
  ('postgresql',          'PostgreSQL',               'data'),
  ('supabase',            'Supabase',                 'data'),
  -- --- design -----------------------------------------------------------------------
  ('graphic-design',      'Diseño Gráfico',           'design'),
  ('ui-design',           'Diseño de Interfaces',     'design'),
  ('ux-research',         'Investigación UX',         'design'),
  -- --- engineering ------------------------------------------------------------------
  ('electronics-design',  'Diseño Electrónico',       'engineering'),
  ('nextjs',              'Next.js',                  'engineering'),
  ('nodejs',              'Node.js',                  'engineering'),
  ('python',              'Python',                   'engineering'),
  ('react',               'React',                    'engineering'),
  ('tailwind-css',        'Tailwind CSS',             'engineering'),
  ('typescript',          'TypeScript',               'engineering'),
  -- --- marketing --------------------------------------------------------------------
  ('growth-marketing',    'Growth Marketing',         'marketing'),
  ('seo',                 'SEO',                      'marketing'),
  -- --- operations -------------------------------------------------------------------
  ('devops',              'DevOps',                   'operations'),
  ('project-management',  'Gestión de Proyectos',     'operations'),
  -- --- quality ----------------------------------------------------------------------
  ('qa-testing',          'QA y Testing',             'quality'),
  ('security-audit',      'Auditoría de Seguridad',   'quality'),
  -- --- research ---------------------------------------------------------------------
  ('market-research',     'Investigación de Mercado', 'research')
on conflict (slug) do update
  set name     = excluded.name,
      category = excluded.category;


-- =====================================================================================
-- FIN — db/seeds/01_skills.sql
-- Verificación: select category, count(*) from public.skills where is_active group by 1;
-- =====================================================================================
