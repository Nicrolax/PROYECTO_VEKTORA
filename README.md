# VEKTORA

Plataforma autónoma de resultados: planificación y orquestación de proyectos por objetivos,
grafos de tareas (DAG), matching híbrido y verificación por reputación de evidencia.

Reglas del proyecto: **sistema 100 % autónomo** (sin gestión humana intermedia),
**infraestructura 100 % gratuita** (free tiers de Supabase, Vercel, Groq y Google AI Studio),
**sin mocks falsos** y **arquitectura separada por dominios**.

Estado: **COMPLETO.** Las siete fases están implementadas y verificadas: modelo de datos,
capa de IA con respaldo, planificador, emparejamiento híbrido, evaluación automática,
interfaz web y endurecimiento para producción.

---

## Arranque

```bash
npm install
cp env.example .env.local     # y rellena las claves
npm run verify                # typecheck estricto + 315 pruebas
npm run dev                   # la aplicación web en http://localhost:3000
npm run db:check              # comprueba que Supabase tiene el esquema aplicado
npm run ai:models             # qué modelos admiten tus claves (los modelos caducan)
npm run ai:check              # comprueba la capa de IA contra las APIs reales
npm run plan -- "Micrositio de captación con formulario y analítica" 3000
```

## Despliegue de la base de datos

El orden importa: cada paso depende del anterior.

1. `db/schema.sql`
2. `db/migrations/0002_planner.sql`
3. `db/migrations/0003_provider_onboarding.sql`
4. `db/migrations/0004_matching.sql`
5. `db/migrations/0005_qa.sql`
6. `db/migrations/0006_realtime.sql`
7. `db/migrations/0007_escalada.sql`
8. `db/seeds/01_skills.sql`
9. `npm run skills:embed` — vectoriza el catálogo (sin esto no hay normalización semántica)

Todos son **idempotentes**: se pueden reaplicar sobre una base ya desplegada sin
destruir datos. `npm run db:check` verifica después que todo lo que el código necesita está
presente. Los detalles del modelo están en `db/LEEME.md`.

---

## Arquitectura

Todo el código de dominio vive bajo `lib/`, y se importa con el alias `@/`. Ningún módulo
importa archivos internos de otro dominio: se importa desde el índice público (`@/lib/ai`,
`@/lib/planner`, `@/lib/supabase`).

```
lib/
  env.ts                     Carga de .env.local para procesos que no son Next.js
  ai/                        FASE 2 — capa de abstracción de IA
    index.ts                 API pública
    ai-client.ts             Orquestador: fallback, reintentos, auto-reparación Zod
    config.ts                Entorno validado con Zod estricto, perezoso y memorizado
    types.ts                 Tipos compartidos; los literales replican los ENUM de la base
    errors.ts                Taxonomía de errores con `retryable` y mapeo a ai_run_status
    json.ts                  Extracción tolerante de JSON de la salida del modelo
    schema.ts                Zod -> JSON Schema -> Schema de Google; prompts de reparación
    pricing.ts               Estimación de cost_usd (0 en free tier, tabla extensible)
    embedding-models.ts      Registro de capacidades de los modelos de embedding
    embeddings.ts            Servicio de embeddings + utilidades de pgvector
    telemetry.ts             Sinks de ai_runs: Supabase / null / en memoria
    providers/
      index.ts               Construcción de la cadena de fallback
      http.ts                fetch con timeout, señal combinada y traducción de estado
      groq.ts                Adaptador Groq (/chat/completions)
      gemini.ts              Adaptador de generación Gemini (:generateContent)
      gemini-embeddings.ts   Adaptador de embeddings (:embedContent)
  planner/                   FASE 3 — ProjectPlanner
    index.ts                 API pública + createProjectPlanner()
    planner.ts               Orquestación completa objetivo -> DAG persistido
    dag.ts                   Álgebra de grafos PURA
    schemas.ts               Contrato Zod del plan, con los invariantes del DAG dentro
    prompts.ts               System prompt, catálogo de skills y refuerzo de grafo
    budget.ts                Reparto por resto mayor, exacto al céntimo
    repository.ts            Interfaz de datos + implementación Supabase
  providers/                 FASE 3.5 — onboarding y catálogo vivo de skills
    index.ts                 API pública + createProviderOnboarding()
    provider.ts              Alta completa: cuenta, perfiles, skills, vectorización
    skills.ts                Resolución en cascada: exacta -> alias -> semántica -> creación
    schemas.ts               Contrato Zod del alta
    repository.ts            Interfaz de datos + implementación Supabase
  matching/                  FASE 4 — motor de matching híbrido
    index.ts                 API pública + createTaskMatcher()
    matcher.ts               Orquestación: vectorizar, recuperar, puntuar, persistir, adjudicar
    scoring.ts               Ranking PURO: vector + skills + reputación
    config.ts                Pesos y umbrales validados con Zod
    repository.ts            Interfaz de datos + implementación Supabase
  qa/                        FASE 5 — agente autónomo de QA (AI Judge)
    index.ts                 API pública + createQaJudge()
    judge.ts                 Orquestación: tomar turno, evaluar, decidir, persistir
    policy.ts                Veredicto PURO: criterios -> estado, nota, reputación
    schemas.ts               Contrato Zod construido con los criterios REALES de la tarea
    prompts.ts               Prompt del juez, sin identidad ni reputación del proveedor
    config.ts                Umbrales y deltas validados con Zod
    repository.ts            Interfaz de datos + implementación Supabase
  qa/                        FASE 5 — agente autónomo de evaluación
    index.ts                 API pública + createQaJudge()
    judge.ts                 Orquestación: tomar turno, evaluar, decidir, persistir
    policy.ts                Veredicto PURO: criterios -> estado, nota, reputación
    schemas.ts               Contrato Zod con los criterios REALES de la tarea
    prompts.ts               Prompt del juez, sin identidad ni reputación del proveedor
    config.ts                Umbrales y deltas validados con Zod
    repository.ts            Interfaz de datos + implementación Supabase
  auth/session.ts            FASE 6 — guardián de sesión
  cron/autorizacion.ts       FASE 6 — secreto de los trabajos programados
  cuotas/index.ts            FASE 7 — límites de uso por usuario
  validacion/entrada.ts      FASE 7 — correos, textos y presupuestos con contenido real
  supabase/
    index.ts                 API pública
    admin.ts                 Cliente service_role, único y perezoso
    server.ts                Cliente con la sesión del usuario, sujeto a RLS
    browser.ts               Cliente anónimo para la suscripción en vivo
    types.ts                 Contratos de fila de db/schema.sql

app/                         FASE 6 — interfaz web (Next.js App Router)
  entrar/                    Alta y acceso
  (app)/panel/               Proyectos del cliente
  (app)/proyectos/           Creación y visualizador del grafo
  (app)/tareas/[id]/         Criterios, candidaturas y veredictos
  (app)/trabajo/[taskId]/    Espacio de entrega del proveedor
  (app)/proveedor/           Panel y alta de proveedor
  acciones/                  Server Actions sobre los orquestadores de lib/
  api/cron/                  Disparadores de los trabajos programados

components/
  grafo/                     Visualizador SVG y disposición PURA
  ui/                        Primitivas, marca y navegación
  estados.ts                 Vocabulario visual de los estados

db/
  schema.sql                 FASE 1 — 14 ENUM, 14 tablas, triggers, índices, RLS, privilegios
  migrations/0002_planner.sql  FASE 3 — apply_project_plan, refresh_task_readiness, project_dag
  migrations/0003_provider_onboarding.sql  FASE 3.5 — resolve_or_create_skill, skill_aliases
  migrations/0004_matching.sql  FASE 4 — match_task_candidates, apply_task_matches, accept_task_application
  migrations/0005_qa.sql     FASE 5 — claim_deliverable_for_qa, apply_qa_verdict, pending_qa_deliverables
  migrations/0006_realtime.sql  FASE 6 — publicación de cambios en vivo
  migrations/0007_escalada.sql  FASE 7 — rondas de emparejamiento y cuotas de uso
  verify/                    Verificación de comportamiento sobre base local desechable
  seeds/01_skills.sql        Catálogo semilla de skills
  diagnose.sql · dump-schema.sql · dump-skills.sql   Diagnóstico (solo lectura)

scripts/
  ai-check.ts                Verificación de la capa de IA contra las APIs reales
  db-check.ts                Verificación del despliegue de Supabase
  plan-project.ts            npm run plan -- "<objetivo>" [presupuesto]
  skills-embed.ts            Vectoriza el catálogo de skills
  provider-add.ts            npm run provider:add -- <perfil.json>
  skills-calibrate.ts        Mide la distribución real de similitudes
  match-task.ts              npm run match -- <task_id> [--assign|--dry-run|--manual]
  deliverable-submit.ts      npm run deliver -- <task_id> <archivo.json|.md>
  qa-review.ts               npm run qa -- <deliverable_id> [--dry-run|--task|--all]
  cron-local.ts              npm run cron — dispara los trabajos programados en local
  cleanup-legacy.ps1         Borrado único de los archivos huérfanos del refactor

tests/                       Suite de Vitest del núcleo (sin red, sin base de datos)
```

### Decisiones que conviene conocer antes de tocar nada

- **La cadena de fallback la dicta `AI_PROVIDER_ORDER`** (por defecto `groq,google`) y solo
  entran los proveedores con clave. Con una sola clave el sistema funciona degradado.
- **Los modelos caducan.** `llama-3.3-70b-versatile` y `gemini-2.5-flash` se retiraron en
  2026 y empezaron a devolver 404. Un 404 que menciona el modelo se trata como error de
  CONFIGURACIÓN, no como petición inválida: el mensaje dice qué hacer y la cadena cede el
  turno sin gastar intentos. `npm run ai:models` lista lo que admiten tus claves — es la
  única fuente de verdad, porque la documentación pública y lo que ve una cuenta concreta
  no siempre coinciden.
- **`retryable` decide todo.** `rate_limit` / `server` / `timeout` / `network` reintentan con
  backoff exponencial y respetan `Retry-After`; `auth` / `bad_request` / `blocked` /
  `truncated` ceden el turno al siguiente proveedor sin gastar intentos.
- **Los invariantes del DAG son refinements de Zod**, no validación posterior. Así el bucle
  de auto-reparación de la FASE 2 recibe mensajes accionables y **el propio modelo corrige
  el grafo**, sin código de reparación específico del planificador.
- **Defensa del grafo en cuatro capas**: prompt → refinements + auto-reparación → reparación
  determinista (`pruneInvalidReferences` + `breakCycles`) → trigger `prevent_dag_cycles` en
  la base. Abortar y esperar a una persona no es opción (regla 1).
- **`vector(1536)`** en `provider_profiles.embedding` y `project_tasks.embedding`. Lo produce
  `gemini-embedding-001` recortado por MRL y **renormalizado L2**, para que `<=>` de pgvector
  siga siendo distancia coseno. Los índices HNSW son **parciales**: las consultas de la
  FASE 4 deben incluir `where embedding is not null` y ordenar por `<=>` o no se usarán.
- **`service_role` bypassea RLS por diseño**: es la identidad de los agentes autónomos.
  `lib/supabase/admin.ts` lanza si se importa en el navegador.
- **`reputation_events` y `audit_logs` son append-only.** La reputación mostrada tiene que
  poder reconstruirse sumando eventos (`delta * weight`), o deja de ser un mecanismo de
  confianza.
- **`project_dag` es una función, no una vista**, y `task_dependencies` usa
  `depends_on_task_id` sin `project_id`. `db/LEEME.md` recoge estas y otras trampas del
  modelo real.
- **El catálogo de skills crece solo pero converge.** Cuando un proveedor declara un slug
  desconocido, se vectoriza y se compara con el catálogo: si supera el umbral se MAPEA a la
  skill existente y el mapeo queda en `skill_aliases`; solo un concepto nuevo crea fila. Sin
  esto, `react` / `reactjs` / `react-18` serían tres skills y el matching devolvería listas
  vacías. El umbral se ajusta con `VEKTORA_SKILL_MATCH_THRESHOLD` (0.95, **medido** con
  `npm run skills:calibrate`; con 0.82 se fusionaba el 76.8% del catálogo).
- **El matching separa recuperación de política.** La base hace la búsqueda aproximada de
  vecinos (lo único que solo ella puede hacer); los pesos, la fórmula y la explicación viven
  en `lib/matching/scoring.ts`, que es puro y se prueba exhaustivamente. Enterrar la fórmula
  en SQL la volvería intocable.
- **El coseno crudo NO discrimina**: con `gemini-embedding-001` todo cae en una banda alta
  y estrecha, así que el tramo útil se reescala a [0,1] (`VEKTORA_MATCH_VECTOR_FLOOR` /
  `_CEILING`). Cuál es el tramo útil depende de QUÉ se compara: entre skills (textos de dos
  palabras) va de 0.77 a 0.92, pero entre **tarea y perfil** — que es lo que el matching
  compara de verdad — va de 0.73 a 0.86. Usar la primera ventana para la segunda dejaba a
  un candidato con cobertura de skills perfecta en 0.2557 de afinidad y su `match_score` en
  0.5563, por debajo del umbral de adjudicación: el motor ordenaba bien y no adjudicaba
  nunca. `npm run skills:calibrate` mide ambas distribuciones por separado.
- **Un proveedor sin historial recibe un prior neutro, no cero.** Penalizar la ausencia de
  historial produce arranque en frío permanente: quien nunca trabajó nunca podría trabajar.
- **`accepts_auto_assign` se comprueba dos veces**, en el filtro SQL y antes de adjudicar.
  Adjudicar trabajo a quien no lo pidió no es autonomía.
- **Ninguna tarea puede quedarse trabada.** Si tras cuatro rondas nadie supera el umbral, se
  adjudica al mejor candidato por encima del mínimo y la traza registra que fue por
  agotamiento. Sin eso, una tarea cuyo mejor candidato puntúa 0.49 contra un umbral de 0.50
  se para para siempre, y con ella todo lo que dependa de ella — porque aquí no hay nadie
  que pueda desatascarla.
- **El AI Judge no decide si se aprueba.** Emite un veredicto POR CRITERIO con la evidencia
  citada; el estado, la nota y la reputación los calcula `lib/qa/policy.ts`, que es puro.
  "¿Apruebas esto?" es un juicio global que un modelo resuelve por impresión general —
  aprueba un texto bien escrito e incompleto, o se pone severo con trabajo correcto—.
  "¿La evidencia demuestra AC-2? Cita la parte que lo prueba" es extracción, que sí hace
  bien. De paso, el umbral deja de estar enterrado en un prompt.
- **Al juez no se le dice quién entregó**: ni nombre, ni reputación, ni precio, ni cuántas
  veces lo intentó. Contarle que el proveedor tiene 5 estrellas convertiría la reputación en
  una profecía autocumplida. La escalada por intentos vive en la política, donde es una
  regla explícita y auditable.
- **Un `pass` con poca confianza no se cuenta como fallo: se degrada a "sin evidencia".**
  La diferencia entre "no lo cumple" y "no puedo comprobarlo" es la diferencia entre cerrar
  una tarea y pedir una captura más. Y la confianza nunca pondera la nota: eso sería dejar
  al modelo moverse la calificación.
- **Una avería nuestra nunca es un rechazo.** Si la IA no responde, el entregable vuelve a
  `error` —estado desde el que la RLS permite reintentar—, no a `rejected`. Cobrarle al
  proveedor nuestra caída de cuota sería el peor fallo posible de un sistema sin humanos.
- **La reputación es un libro mayor append-only**, así que el guardia contra el doble cobro
  es previo al INSERT: no se emite un `event_type` que ese entregable ya generó. Un
  veredicto posterior que contradiga a otro AÑADE el evento contrario en vez de borrar.
- **La clave `service_role` nunca llega al navegador.** Las páginas leen con la sesión del
  usuario y clave anónima, así que todo pasa por las 44 políticas de acceso: si una consulta
  no devuelve una fila es porque la base no deja verla, no porque el código se acordó de
  filtrar. Solo las acciones de servidor usan privilegios plenos, y siempre tras validar la
  sesión.
- **Las cuotas se cuentan en la base, no en el proceso.** Es el único sitio donde el recuento
  es atómico: dos pestañas pulsando a la vez no pueden consumir el mismo hueco. Si el
  contador falla, se PERMITE la acción — el límite protege una cuota, no custodia nada
  crítico, y dejar a la gente sin trabajar por eso sería peor que el riesgo que evita.
- **Los trabajos programados son infraestructura, no un detalle.** Sin un reloj que dispare
  el emparejamiento y la evaluación, el sistema solo avanza cuando alguien ejecuta algo, y
  eso es intervención humana disfrazada.

---

## Comandos

| Comando | Qué hace |
|---|---|
| `npm run typecheck` | `tsc --noEmit` con `strict`, `noUncheckedIndexedAccess` y `exactOptionalPropertyTypes` |
| `npm test` | Suite de Vitest del núcleo |
| `npm run verify` | typecheck + pruebas |
| `npm run db:check` | Comprueba tablas, columnas, RPC, catálogo y propietario en Supabase |
| `npm run ai:models` | Lista los modelos que admiten tus claves y marca si el configurado ya no existe |
| `npm run ai:check` | Comprueba configuración, generación, fallback y embeddings contra las APIs reales |
| `npm run skills:embed` | Vectoriza el catálogo de skills (`--all` recalcula todo) |
| `npm run provider:add -- <perfil.json>` | Da de alta un proveedor (`--ejemplo` imprime una plantilla) |
| `npm run skills:calibrate` | Mide la distribución de similitudes y propone umbrales |
| `npm run match -- <task_id>` | Matching híbrido de una tarea (`--assign`, `--dry-run`, `--manual`) |
| `npm run deliver -- <task_id> <archivo>` | Registra un entregable para que el juez lo evalúe |
| `npm run qa -- <deliverable_id>` | Evalúa un entregable contra sus criterios (`--dry-run`, `--task`, `--all`) |
| `npm run plan -- "<objetivo>" [presupuesto]` | Planifica un proyecto real de punta a punta |
| `npm run dev` | Levanta la aplicación web en desarrollo |
| `npm run build` | Compilación de producción |
| `npm run cron` | Dispara emparejamiento y evaluación en local (en producción lo hace el reloj de Vercel) |

## Variables de entorno

Todas están documentadas en `env.example`. Las obligatorias son `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY` y al menos una de `GROQ_API_KEY` / `GOOGLE_AI_API_KEY`.
`VEKTORA_OWNER_ID` es opcional: si se define, debe ser el uuid de una fila existente de
`public.users`, y `npm run plan` lo verifica antes de gastar una llamada al modelo.
`VEKTORA_SKILL_MATCH_THRESHOLD` también es opcional (0.95, **medido**): baja el valor para
agrupar más agresivamente, súbelo para que el catálogo crezca con más facilidad. Los
umbrales del juez (`VEKTORA_QA_*`) son política de producto y están documentados uno a uno
en `env.example`.

`.env.local` **nunca** se versiona: contiene la clave `service_role`.

---

## Documentación

`docs/` contiene el desarrollo teórico, los requisitos, el stack, los diagramas UML, los
casos de uso, la infraestructura y la guía de despliegue. Empezar por
[`docs/00-indice.md`](docs/00-indice.md).

La documentación técnica de cada fase —decisiones de diseño, errores encontrados y cómo se
corrigieron— vive en el espacio de trabajo del proyecto.
