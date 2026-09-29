# db/verify — verificación de la capa de datos

Comprueba que el SQL **se comporta** como debe, no solo que se aplica sin errores. Existe
porque durante la refactorización se enviaron dos veces archivos que aplicaban limpio en
apariencia y fallaban al ejecutarse: `42703` por una columna inexistente y `42601` por una
variable `%rowtype` dentro de un `INTO` con varios destinos. Ninguno de los dos lo habría
atrapado una revisión visual.

**Se ejecuta contra una base local desechable, nunca contra Supabase**: crea usuarios,
proyectos y skills de prueba.

## Cómo correrlo

Necesitás PostgreSQL 16 y pgvector. En Debian/Ubuntu:

```bash
sudo apt-get install -y postgresql postgresql-16-pgvector
export PGDATA=/tmp/pgdata
/usr/lib/postgresql/16/bin/initdb -D "$PGDATA" -U postgres --auth=trust
/usr/lib/postgresql/16/bin/pg_ctl -D "$PGDATA" -o '-p 5433 -k /tmp' -l /tmp/pg.log start

P="psql -h /tmp -p 5433 -U postgres -d postgres -v ON_ERROR_STOP=1"
$P -f db/verify/00_harness.sql
$P -f db/schema.sql
$P -f db/migrations/0002_planner.sql
$P -f db/migrations/0003_provider_onboarding.sql
$P -f db/migrations/0004_matching.sql
$P -f db/migrations/0005_qa.sql
$P -f db/seeds/01_skills.sql
$P -f db/verify/01_comportamiento.sql
$P -f db/verify/02_rls.sql
$P -f db/verify/03_matching.sql
```

En Windows conviene hacerlo dentro de WSL o de un contenedor `postgres:16`.

## Qué contiene cada archivo

| Archivo | Qué hace |
|---|---|
| `00_harness.sql` | Reproduce lo que Supabase da por hecho: esquema `auth`, `auth.users`, `auth.uid()` y los roles `anon` / `authenticated` / `service_role` (este último con `bypassrls`) |
| `01_comportamiento.sql` | Bootstrap de cuentas, `apply_project_plan`, rechazo de ciclos, `refresh_task_readiness`, la cascada de `resolve_or_create_skill`, alta de proveedor y privilegios de `anon` |
| `02_rls.sql` | Aislamiento por RLS, con transacciones explícitas |
| `03_matching.sql` | Filtros duros de candidatos, shortlist idempotente, adjudicación atómica y sus carreras |

## Lo verificado (2026-09-14, PostgreSQL 16.13 + pgvector 0.6.0)

Los cuatro archivos aplican limpio y son **idempotentes** (segunda pasada sin errores).

**Comportamiento**

- El trigger de `auth.users` proyecta a `public.users` y `public.profiles` con el nombre.
- `apply_project_plan` persiste un diamante de 4 tareas con presupuestos que suman
  **3000.00 exactos**, devuelve el mapa `code -> uuid` y mueve el proyecto a `planned`.
- Una arista que cierra un ciclo se rechaza con **SQLSTATE 23514** y el mensaje trae la
  ruta completa — que es lo que el ProjectPlanner necesita para repararse.
- Aprobar `T-01` deja `T-02` y `T-03` en `ready` y `T-04` en `blocked`: espera a las dos.
- `normalize_skill_slug`: `React 18 → react-18`, `  NEXT.js  → next-js`, `--- → NULL`.
- La cascada de resolución, en orden: `React → exact`, `reactjs → semantic (0.99015)`,
  `reactjs` otra vez `→ alias` (ya no gasta embedding), `soldadura tig → created`.
- `upsert_provider_profile` con payload parcial **no vacía** los campos ausentes.

**Seguridad**

- Un tercero ve 0 proyectos, 0 tareas y 0 aristas; el dueño ve 1, 4 y 4.
- Un `UPDATE` de un tercero sobre el proyecto ajeno afecta 0 filas.
- `apply_project_plan` rechaza al tercero: *"proyecto inexistente o sin acceso"*.
- Un usuario no puede escalar su propio `role` a `admin`.
- `reputation_events` es append-only, y el trigger proyecta la reputación correctamente.
- Un tercero no puede tocar el perfil de otro proveedor.
- `anon` **no** tiene EXECUTE sobre `apply_project_plan`, pero **sí lo conserva** sobre
  `is_admin()` — sin eso, `skills_select_all` fallaría y `anon` no podría leer el catálogo.

## FASE 4 — motor de matching (12 comprobaciones más)

- Los filtros duros excluyen al dueño del proyecto, a quien pide un presupuesto mínimo
  mayor que el de la tarea, y a quien no acepta asignación automática.
- Un proveedor **sin embedding** entra igual en los candidatos (rama B): si no, alguien
  cuya vectorización falló sería invisible para siempre.
- `apply_task_matches` mueve la tarea a `matching`, y al reaplicarse **refresca** la
  puntuación en lugar de duplicar candidaturas.
- Una candidatura ya `rejected` **no se reabre** en un recálculo, y ese proveedor deja de
  proponerse para esa tarea.
- `accept_task_application` asigna, acepta una y rechaza el resto en una sola transacción.
  Una segunda adjudicación falla con `unique_violation` en vez de pisar a la primera.
- `anon` no tiene EXECUTE sobre ninguna función del motor.

## FASE 5 — AI Judge (12 comprobaciones más)

Se ejecuta con `$P -f db/verify/04_qa.sql`, después de la migración `0005_qa.sql`.

- `claim_deliverable_for_qa` toma el turno y devuelve entregable, tarea, criterios y
  proyecto en una sola ida y vuelta. Un **segundo juez no puede tomar el mismo
  entregable**: queda en `running` y el intento devuelve el motivo.
- `release_deliverable_qa` deja el entregable en `error`, **no** como rechazado: un fallo
  del proveedor de modelos no puede castigar a quien entregó, y `error` es uno de los
  estados en los que la RLS le permite reintentar.
- `apply_qa_verdict` escribe veredicto, reseña automática, eventos de reputación y estado de
  la tarea **en una transacción**. Al aprobar, el trigger de la 0002 recalcula el DAG y la
  tarea que dependía de ella pasa de `blocked` a `ready` sola.
- Un entregable **ya aprobado no se vuelve a juzgar**: el veredicto es terminal, así que un
  mal día del modelo no puede revocar trabajo aceptado.
- `apply_qa_verdict` sobre algo que no está en `running` **no pisa nada** y lo informa.
- **La reputación no se cobra dos veces.** Reaplicar el mismo veredicto escribe 0 eventos y
  devuelve los omitidos: la tabla es append-only y después no hay corrección posible.
- Una sola **reseña automática por tarea**: un segundo entregable actualiza el rating en vez
  de acumular reseñas.
- `reputation_events` sigue rechazando UPDATE.
- `anon` y `authenticated` no tienen EXECUTE sobre ninguna función del juez.

## FASE 7 — escalada y cuotas (11 comprobaciones más)

Se ejecuta con `$P -f db/verify/05_escalada_y_cuotas.sql`, tras la migración `0007_escalada.sql`.

- Las rondas de emparejamiento **arrancan en cero y se incrementan**; al adjudicarse la tarea
  **vuelven a cero**, de modo que si se reabre por una revisión el mercado compite en
  igualdad de condiciones.
- Una tarea **ya adjudicada no acumula rondas**: el emparejador no la vuelve a contar.
- La cuota **permite hasta el límite y después corta**, y el rechazo dice **cuándo se libera
  el siguiente hueco** en lugar de un «no puedes» a secas.
- La cuota es **por usuario y por acción**: agotar la de proyectos no impide entregar, y el
  límite de una persona no afecta a otra.
- **Un rechazo NO consume hueco.** Si lo consumiera, chocar contra el límite lo alejaría más.
- Una ventana que ya pasó **no cuenta**: el límite es deslizante, no un contador que se
  reinicia a medianoche.
- **Límite cero deshabilita la acción, no la abre.** Es el modo de fallo que importaba cerrar.
- `anon` y `authenticated` **no pueden fabricarse cuota** ni tocar el contador de rondas.
