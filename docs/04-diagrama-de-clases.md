# Diagrama de clases

Los nombres, métodos y relaciones se corresponden con el código del repositorio.

El sistema se organiza en cuatro capas. Cada diagrama de este documento cubre una:

| Capa | Responsabilidad | Diagrama |
|---|---|---|
| Aplicación | Puntos de entrada: interfaz web, acciones de servidor y trabajos programados | §1 |
| Orquestación | Los cuatro agentes del dominio y sus repositorios | §2 |
| Abstracción de IA | Proveedores de modelos, vectorización, telemetría | §3 |
| Dominio persistido | Entidades y sus cardinalidades | §4 |

## 1. Capa de aplicación

Los agentes autónomos se invocan desde el servidor, nunca desde el navegador: es lo que
mantiene la clave con privilegios plenos fuera del cliente. La interfaz llama a acciones de
servidor; los trabajos programados llaman a los mismos casos de uso sin que nadie inicie
sesión, y son los que hacen que el sistema avance solo.

```mermaid
classDiagram
    direction TB

    class ProjectActions {
        <<server actions>>
        +createProject(objective, budget) ProjectView
        +getProjectGraph(projectId) GraphView
        +getTaskDetail(taskId) TaskDetailView
    }

    class ProviderActions {
        <<server actions>>
        +registerProvider(input) ProviderView
        +updateSkills(profileId, skills) SkillResolutionView
        +getProviderDashboard(userId) DashboardView
    }

    class DeliverableActions {
        <<server actions>>
        +submitDeliverable(taskId, input) DeliverableView
        +getVerdict(deliverableId) VerdictView
    }

    class MatchingJob {
        <<route handler>>
        +POST(request) JobReport
        -matchReadyTasks(limit) MatchTaskResult[]
    }

    class QaJob {
        <<route handler>>
        +POST(request) JobReport
        -judgePendingDeliverables(limit) JudgeResult[]
    }

    class SessionGuard {
        +requireUser() SessionUser
        +requireTaskAssignee(taskId) SessionUser
        +requireProjectOwner(projectId) SessionUser
    }

    class ProjectPlanner
    class ProviderOnboarding
    class TaskMatcher
    class QaJudge

    ProjectActions ..> SessionGuard : valida sesión
    ProviderActions ..> SessionGuard
    DeliverableActions ..> SessionGuard

    ProjectActions ..> ProjectPlanner : invoca
    ProviderActions ..> ProviderOnboarding
    DeliverableActions ..> QaJudge : consulta veredicto
    MatchingJob ..> TaskMatcher : invoca
    QaJob ..> QaJudge : invoca
```

Las acciones de servidor y los trabajos programados son dos puertas al **mismo** núcleo. Esa
simetría es deliberada: nada de lo que hace el sistema depende de que una persona pulse algo,
y lo que una persona pulsa no toma un atajo distinto del que toma el sistema por su cuenta.

## 2. Núcleo de orquestación

### Patrón que organiza esta capa

Cada dominio (planificador, proveedores, emparejamiento, evaluación) repite la misma
estructura de tres piezas:

- un **orquestador** con la lógica del caso de uso,
- una **interfaz de repositorio** que declara qué datos necesita,
- una **implementación Supabase** de esa interfaz.

El orquestador depende de la interfaz, nunca de la implementación. Eso es lo que permite
probar la lógica de decisión con dobles, sin red ni base de datos, que es donde el sistema
puede equivocarse en silencio.

```mermaid
classDiagram
    direction LR

    class ProjectPlanner {
        -PlannerRepository repository
        -AiClient ai
        -EmbeddingService embeddings
        +planProject(input) PlanProjectResult
        -toPersistableTasks(plan) PersistableTask[]
        -findUnknownSkills(plan) string[]
    }

    class ProviderOnboarding {
        -ProviderRepository repository
        -SkillResolver resolver
        -EmbeddingService embeddings
        +register(input) RegisterProviderResult
    }

    class SkillResolver {
        -ProviderRepository repository
        -EmbeddingService embeddings
        -number threshold
        +resolve(proposals) ResolveSkillsResult
    }

    class TaskMatcher {
        -MatchingRepository repository
        -EmbeddingService embeddings
        -MatchingConfig config
        +matchTask(input) MatchTaskResult
    }

    class QaJudge {
        -QaRepository repository
        -AiClient ai
        -QaConfig config
        +judge(input) JudgeResult
        +queue(limit) PendingDeliverable[]
        +judgeQueue(limit, dryRun) JudgeResult[]
    }

    class PlannerRepository {
        <<interface>>
        +fetchSkillCatalog() SkillCatalogEntry[]
        +registerSkills(slugs) number
        +createProject(input) ProjectRecord
        +applyPlan(projectId, tasks, edges, metadata) ApplyPlanResult
        +saveTaskEmbeddings(entries) number
    }

    class ProviderRepository {
        <<interface>>
        +fetchSkillCatalog() SkillCatalogEntry[]
        +findSkillBySlug(slug) SkillRecord
        +resolveOrCreateSkill(raw, vector) SkillResolution
        +upsertProviderProfile(input) ProviderProfileRecord
        +setProviderSkills(profileId, skills) number
    }

    class MatchingRepository {
        <<interface>>
        +loadTask(taskId) MatchTaskRecord
        +saveTaskEmbedding(taskId, vector, model) boolean
        +fetchCandidates(params) MatchCandidate[]
        +applyMatches(taskId, matches) ApplyMatchesResult
        +acceptApplication(applicationId) AcceptResult
    }

    class QaRepository {
        <<interface>>
        +claim(deliverableId) QaClaimResult
        +release(deliverableId, status, error) boolean
        +applyVerdict(input) ApplyVerdictResult
        +pending(limit) PendingDeliverable[]
        +latestDeliverableForTask(taskId) string
    }

    class SupabasePlannerRepository
    class SupabaseProviderRepository
    class SupabaseMatchingRepository
    class SupabaseQaRepository

    ProjectPlanner --> PlannerRepository : usa
    ProviderOnboarding --> ProviderRepository : usa
    ProviderOnboarding --> SkillResolver : compone 1
    SkillResolver --> ProviderRepository : usa
    TaskMatcher --> MatchingRepository : usa
    QaJudge --> QaRepository : usa

    PlannerRepository <|.. SupabasePlannerRepository
    ProviderRepository <|.. SupabaseProviderRepository
    MatchingRepository <|.. SupabaseMatchingRepository
    QaRepository <|.. SupabaseQaRepository
```

## 3. Capa de abstracción de IA

```mermaid
classDiagram
    direction TB

    class AiClient {
        -AiConfig config
        -LlmProvider[] providers
        -TelemetrySink telemetry
        +generateStructured(request) StructuredResponse
        +generateText(request) TextResponse
        +providerChain() AiProviderId[]
        -backoffMs(attempt, retryAfterMs) number
    }

    class LlmProvider {
        <<interface>>
        +AiProviderId id
        +string model
        +generate(request) GenerateResult
    }

    class EmbeddingProvider {
        <<interface>>
        +string model
        +number dimensions
        +embed(texts, taskType) number[][]
    }

    class EmbeddingService {
        -EmbeddingProvider provider
        +number dimensions
        +embedTexts(request) EmbedTextsResponse
        +embedText(text) number[]
        +isAvailable() boolean
        +describeModel() string
    }

    class TelemetrySink {
        <<interface>>
        +start(run) string
        +finish(run) void
    }

    class GroqProvider
    class GeminiProvider
    class GeminiEmbeddingProvider
    class SupabaseTelemetrySink
    class InMemoryTelemetrySink
    class NullTelemetrySink

    class AiError {
        +AiErrorCode code
        +boolean retryable
        +AiProviderId provider
        +number status
    }
    class AiExhaustedError {
        +AiAttemptFailure[] failures
        +lastFailure AiAttemptFailure
    }

    LlmProvider <|.. GroqProvider
    LlmProvider <|.. GeminiProvider
    EmbeddingProvider <|.. GeminiEmbeddingProvider
    TelemetrySink <|.. SupabaseTelemetrySink
    TelemetrySink <|.. InMemoryTelemetrySink
    TelemetrySink <|.. NullTelemetrySink
    AiError <|-- AiExhaustedError

    AiClient o-- "1..*" LlmProvider : cadena de respaldo
    AiClient --> TelemetrySink : registra en
    AiClient ..> AiExhaustedError : lanza
    EmbeddingService --> EmbeddingProvider : usa

    ProjectPlanner ..> AiClient
    QaJudge ..> AiClient
    ProjectPlanner ..> EmbeddingService
    ProviderOnboarding ..> EmbeddingService
    TaskMatcher ..> EmbeddingService
```

`AiClient` agrega **una o más** implementaciones de `LlmProvider` en orden de preferencia: si
la primera falla con un error reintentable se reintenta con espera exponencial, y si falla con
un error no reintentable se cede el turno a la siguiente sin gastar intentos. Con una sola
clave configurada el sistema funciona en modo degradado.

## 4. Modelo de dominio persistido

Entidades de `db/schema.sql` con sus cardinalidades reales.

```mermaid
classDiagram
    direction TB

    class User {
        +UUID id
        +string email
        +UserRole role
        +UserStatus status
        +boolean isAgent
    }

    class ProviderProfile {
        +UUID id
        +UUID userId
        +string headline
        +Vector~1536~ embedding
        +number reputationScore
        +number avgRating
        +number onTimeRate
        +number minTaskBudgetUsd
        +boolean acceptsAutoAssign
    }

    class Skill {
        +UUID id
        +string slug
        +string name
        +string category
        +Vector~1536~ embedding
    }

    class SkillAlias {
        +UUID id
        +string alias
        +UUID skillId
        +number similarity
    }

    class ProviderSkill {
        +UUID providerProfileId
        +UUID skillId
        +number level
        +number yearsExperience
    }

    class Project {
        +UUID id
        +UUID ownerId
        +string title
        +string objective
        +ProjectStatus status
        +number budgetTotal
        +JSONB plannerMetadata
    }

    class ProjectTask {
        +UUID id
        +UUID projectId
        +string code
        +string title
        +JSONB acceptanceCriteria
        +string[] requiredSkills
        +TaskStatus status
        +UUID assigneeId
        +number budget
        +Vector~1536~ embedding
    }

    class TaskDependency {
        +UUID taskId
        +UUID dependsOnTaskId
        +DependencyType dependencyType
    }

    class TaskApplication {
        +UUID id
        +UUID taskId
        +UUID providerId
        +ApplicationStatus status
        +number vectorScore
        +number skillScore
        +number reputationScore
        +number matchScore
        +JSONB matchExplanation
    }

    class Deliverable {
        +UUID id
        +UUID taskId
        +UUID providerId
        +number version
        +JSONB evidence
        +QaStatus qaStatus
        +number qaScore
        +JSONB qaCriteriaResults
        +UUID qaRunId
    }

    class Review {
        +UUID id
        +UUID taskId
        +UUID reviewerId
        +UUID revieweeId
        +ReviewSource source
        +number rating
    }

    class ReputationEvent {
        +UUID id
        +UUID userId
        +ReputationEventType eventType
        +number delta
        +number weight
    }

    class AiRun {
        +UUID id
        +AiOperation operation
        +AiProvider provider
        +AiRunStatus status
        +number totalTokens
        +number costUsd
    }

    User "1" -- "0..1" ProviderProfile : es proveedor
    User "1" -- "0..*" Project : posee
    ProviderProfile "1" -- "0..*" ProviderSkill
    Skill "1" -- "0..*" ProviderSkill
    Skill "1" -- "0..*" SkillAlias
    Project "1" -- "2..24" ProjectTask : contiene
    ProjectTask "1" -- "0..*" TaskDependency : depende de
    ProjectTask "1" -- "0..*" TaskApplication : recibe
    User "1" -- "0..*" TaskApplication : postula
    ProjectTask "1" -- "0..*" Deliverable : entrega
    Deliverable "0..1" -- "0..1" Review : origina
    Review "0..1" -- "0..*" ReputationEvent : justifica
    Deliverable "0..1" -- "0..1" AiRun : juzgada por
```

### Notas de cardinalidad

- **`Project` 1 — 2..24 `ProjectTask`**: el rango no es decorativo. Lo impone el esquema Zod
  del planificador (`MIN_TASKS` = 2, `MAX_TASKS` = 24).
- **`ProjectTask` 1 — 0..* `Deliverable`**: una tarea puede acumular varias versiones del
  entregable y `version` se asigna sola por trigger, pero **todo entregable pertenece a
  exactamente una tarea** (`deliverables.task_id` es `not null`).
- **`Deliverable` 0..1 — 0..1 `Review`**: un índice único parcial garantiza **una sola reseña
  automática por (tarea, evaluado, fuente)**. Un segundo entregable de la misma tarea
  actualiza esa reseña en lugar de crear otra.
- **`Review` 0..1 — 0..* `ReputationEvent`**: la tabla de reputación es *append-only* (un
  trigger rechaza UPDATE y DELETE). Cualquier puntuación mostrada debe poder reconstruirse
  sumando `delta × weight`.
- **`Deliverable` 0..1 — 0..1 `AiRun`**: `qa_run_id` es opcional, porque un entregable puede
  resolverse sin consultar al modelo (por ejemplo, una entrega vacía). Y la mayoría de las
  corridas de IA —planificación, vectorización— no proceden de ningún entregable.
- **`TaskDependency`** es la tabla de asociación que forma el DAG. Un trigger
  (`prevent_dag_cycles`) impide insertar una arista que cierre un ciclo, incluso si el código
  de aplicación fallara.

---

**Uso de IA y autoría.** Este documento se elaboró con asistencia de Claude (Anthropic,
modelo `claude-opus-5`). Las decisiones de diseño, la revisión y la verificación son de los
autores, que asumen la responsabilidad sobre su contenido. Constancia formal en
[`11-declaracion-de-uso-de-ia.md`](11-declaracion-de-uso-de-ia.md).
