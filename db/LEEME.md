# db/ — capa de datos versionada

Los archivos de este directorio están reconstruidos (2026-09-14) desde el **volcado de
catálogos de la base realmente desplegada** — `pg_type`, `information_schema.columns`,
`pg_constraint`, `pg_indexes`, `pg_policies`, `pg_trigger` y `pg_get_functiondef` — y no
desde la documentación de las fases. Los cuerpos de función y las políticas RLS son
literales, no una reinterpretación.

Esto importa porque el primer intento SÍ se dedujo de los documentos de FASE 1 y 3, y no
coincidía: la documentación describe `task_dependencies.depends_on_id` y un `project_id`
desnormalizado que no existen, `reputation_events.provider_id` en lugar de `user_id`,
`provider_profiles.hourly_rate` en lugar de `hourly_rate_usd`, y `users.full_name` cuando
el nombre vive en `profiles`. Aplicar aquel archivo habría roto la base.

## Orden de despliegue

| # | Archivo | Contenido |
|---|---|---|
| 1 | `schema.sql` | 14 ENUM, 14 tablas, triggers de ciclo e integridad, 60 índices (2 HNSW), helpers de autorización, 44 políticas RLS, privilegios |
| 2 | `migrations/0002_planner.sql` | `refresh_task_readiness`, `propagate_task_readiness`, `apply_project_plan`, `register_skills`, `project_dag` |
| 3 | `migrations/0003_provider_onboarding.sql` | `skills.embedding`, `skill_aliases`, `normalize_skill_slug`, `resolve_or_create_skill`, `upsert_provider_profile`, `set_provider_skills` |
| 4 | `migrations/0004_matching.sql` | `match_task_candidates`, `apply_task_matches`, `accept_task_application`, `skill_similarity_pairs` |
| 5 | `seeds/01_skills.sql` | Catálogo semilla: 30 skills en 9 categorías |
| 6 | `npm run skills:embed` | Vectoriza el catálogo. Sin esto no hay resolución semántica. |

Los tres son idempotentes: reaplicarlos sobre una base al día no cambia nada.

Verificación posterior: `npm run db:check`.

## Verificación

`db/verify/` corre el SQL contra una base local desechable y comprueba que **se comporta**
como debe: DAG, rechazo de ciclos, avance automático, cascada de resolución de skills,
alta de proveedor, recuperación de candidatos, adjudicación atómica y aislamiento por RLS.
28 comprobaciones, todas en verde contra PostgreSQL 16.13 + pgvector 0.6.0. Ver `db/verify/LEEME.md`.

Existe porque dos veces se enviaron archivos que parecían correctos y fallaban al
ejecutarse (`42703` por una columna inexistente, `42601` por un `%rowtype` en un `INTO`
múltiple). Ninguna revisión visual los habría atrapado.

## Utilidades de diagnóstico (solo lectura)

| Archivo | Para qué |
|---|---|
| `diagnose.sql` | Lista las 14 tablas con sus columnas. Rápido, para ver si falta algo. |
| `dump-schema.sql` | Volcado completo: enums, columnas, restricciones, índices, políticas, triggers, vistas y funciones. Es de donde salieron estos archivos. |
| `dump-skills.sql` | Regenera el INSERT de `seeds/01_skills.sql` desde la base. Útil tras añadir skills a mano. |

## Detalles que sorprenden si no se leyó el esquema

- **`project_dag` es una FUNCIÓN, no una vista.** Devuelve el grafo entero de un proyecto
  en un solo `jsonb` (tareas + aristas por código). Se invoca con
  `supabase.rpc('project_dag', { p_project_id })`, no con `.from('project_dag')`.
- **`task_dependencies` no tiene `project_id`.** La pertenencia se deriva de
  `project_tasks`, y `prevent_dag_cycles` comprueba que ambos extremos sean del mismo
  proyecto. La columna de destino es `depends_on_task_id`.
- **`ai_run_status` no tiene `cancelled`**, pero sí `timeout`. Una cancelación se registra
  como `failed` con el motivo en `error_message`.
- **La operación del AI Judge se llama `qa_judge`**, no `qa_review`.
- **`users` es identidad**; el nombre y el avatar están en `profiles`. `users.email` es
  nullable porque una cuenta de agente puede no tener correo.
- **`ai_runs`, `reputation_events` y `audit_logs` no tienen política de escritura**: solo
  las escribe `service_role`, que bypassea RLS. Las dos últimas son además append-only por
  trigger.
