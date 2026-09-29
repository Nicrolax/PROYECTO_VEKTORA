# Desarrollo teórico de la situación problema

## 1. Contexto

El trabajo por proyectos entre clientes y profesionales independientes se canaliza hoy por
plataformas de *freelancing* (Upwork, Workana, Fiverr) o por contacto directo. En ambos casos
el cuello de botella es el mismo y es **humano**: alguien tiene que descomponer el objetivo
en tareas, decidir quién hace cada una, revisar lo entregado y decidir si se paga.

Ese trabajo de coordinación no es accesorio. En proyectos pequeños —los más numerosos— puede
consumir más esfuerzo que la ejecución misma, y recae sobre un cliente que muchas veces no
tiene el criterio técnico para hacerlo: no sabe en cuántas tareas conviene partir su
objetivo, ni qué perfil necesita cada una, ni cómo verificar que lo entregado sirve.

De ahí se derivan tres consecuencias observables en las plataformas actuales:

1. **El cliente decide sobre lo que no domina.** Elige proveedor comparando precio y
   estrellas, porque es lo único que entiende de una lista de candidatos.
2. **La reputación se autoperpetúa.** Quien tiene historial recibe más trabajo y acumula más
   historial; quien empieza no consigue el primero. Es un arranque en frío estructural.
3. **La aceptación es subjetiva y tardía.** Se discute si el trabajo "está bien" cuando ya
   está hecho, porque rara vez se acordó por escrito y de antemano qué lo haría aceptable.

## 2. Actores

| Actor | Qué aporta | Qué necesita |
|---|---|---|
| **Cliente** | Un objetivo en lenguaje natural y un presupuesto | Que el objetivo se convierta en resultado sin tener que gestionar el proceso |
| **Proveedor** | Habilidades declaradas y capacidad de ejecución | Recibir trabajo que encaje con lo que sabe hacer, y poder entrar al mercado sin historial previo |
| **Agente planificador** | Descomposición del objetivo en un grafo de tareas | Un contrato de salida verificable |
| **Agente de matching** | Asignación de tarea a proveedor | Señales comparables: afinidad, habilidades, reputación |
| **Agente evaluador (juez)** | Veredicto sobre lo entregado | Criterios de aceptación escritos de antemano y evidencia que contrastar |

Los tres últimos son **actores del sistema, no personas**. Esa es la decisión que define el
proyecto.

## 3. Problema

> Coordinar un proyecto por objetivos —descomponerlo, asignarlo, verificarlo y cerrarlo—
> exige un trabajo de gestión humana que encarece los proyectos pequeños hasta volverlos
> inviables, concentra decisiones técnicas en quien menos criterio tiene para tomarlas y
> bloquea la entrada de proveedores nuevos al mercado.

## 4. Alcance

**Dentro:**

- Conversión de un objetivo en lenguaje natural en un grafo acíclico dirigido de tareas, con
  criterios de aceptación y presupuesto repartido.
- Alta de proveedores con normalización semántica de habilidades.
- Emparejamiento tarea ↔ proveedor y adjudicación automática.
- Registro de entregables y evaluación automática contra los criterios de aceptación.
- Reputación derivada de veredictos, como libro mayor auditable.
- Avance automático del grafo al aprobarse una tarea.

**Fuera:**

- **Pagos.** No se procesa dinero. El presupuesto es una magnitud del modelo, no una
  transacción. Integrar una pasarela exigiría identidad verificada, facturación y resolución
  de disputas: un proyecto en sí mismo.
- **Mensajería entre cliente y proveedor.** Deliberado: un canal de negociación reintroduce
  la coordinación humana que el sistema elimina.
- **Ejecución del trabajo.** El sistema coordina; el trabajo lo hace el proveedor.
- **Resolución de disputas.** Un veredicto automático desfavorable no tiene hoy instancia de
  apelación. Es una limitación conocida, no un olvido (ver sección 7).

## 5. Solución propuesta

Una plataforma donde **las tres decisiones de coordinación las toman agentes de IA**, y donde
cada decisión queda registrada con su explicación.

1. **Planificación.** Un modelo de lenguaje descompone el objetivo en tareas con
   dependencias, habilidades requeridas, esfuerzo estimado, presupuesto y criterios de
   aceptación. La salida se valida contra un esquema que incluye los invariantes del grafo.
2. **Emparejamiento.** Combina similitud semántica entre tarea y perfil (pgvector) con
   cobertura de habilidades y reputación. La recuperación de candidatos ocurre en la base de
   datos; la fórmula de puntuación vive en código puro y auditable.
3. **Evaluación.** Un agente juez contrasta la evidencia entregada contra cada criterio de
   aceptación, uno por uno. El veredicto global lo calcula una política determinista, no el
   modelo.
4. **Avance.** Al aprobarse una tarea, las que dependían de ella se desbloquean solas, y
   trabajos programados vuelven a emparejarlas sin que nadie lo pida. Ese lazo es lo que hace
   que el proyecto progrese mientras el cliente no mira.

El cliente sigue el avance en un visualizador interactivo del grafo, donde cada decisión
—por qué se eligió a este proveedor, por qué se aprobó o se devolvió este entregable— se
puede abrir y leer con su desglose completo. **La autonomía no exime de rendir cuentas: la
sustituye por trazabilidad.**

### Cómo ataca cada consecuencia del problema

| Consecuencia | Mecanismo |
|---|---|
| El cliente decide sobre lo que no domina | Solo aporta objetivo y presupuesto; la descomposición y la adjudicación son automáticas |
| La reputación se autoperpetúa | Quien no tiene historial recibe un valor neutro (0,5), no cero. El umbral de adjudicación está derivado de forma que un proveedor nuevo con las habilidades requeridas y afinidad típica **pueda ganar la adjudicación** |
| La aceptación es subjetiva y tardía | Los criterios se escriben al planificar, antes de que nadie trabaje, y se evalúan uno a uno con la evidencia citada |

## 6. Alternativa descartada: plataforma asistida por IA

La alternativa considerada fue el modelo **asistido**, que es lo que hacen hoy las
plataformas existentes: la IA sugiere una descomposición, recomienda candidatos y resume los
entregables, pero **cada decisión la confirma una persona**.

Ventajas reales de esa alternativa: un error del modelo no produce daño porque alguien lo
intercepta; no hace falta resolver el problema de un veredicto automático injusto; y se puede
construir por partes, entregando valor desde la primera sugerencia.

**Se descartó por dos razones.**

La primera es que no resuelve el problema planteado, solo lo abarata. El cuello de botella es
la carga de coordinación humana; una plataforma que sugiere y espera confirmación **mantiene
al humano en el camino crítico**. El proyecto pequeño sigue siendo inviable, porque el coste
que lo mataba —el tiempo de decisión de una persona— sigue ahí.

La segunda es de diseño. Cuando se admite que "si el sistema no está seguro, decide una
persona", esa salida se convierte en el destino por defecto de todos los casos difíciles, y
el sistema nunca se ve obligado a resolverlos bien. La restricción de autonomía total obliga
a enfrentar de verdad las preguntas duras: qué hacer cuando ningún candidato es bueno, cómo
distinguir "no cumple" de "no puedo verificarlo", cuántos intentos conceder antes de cerrar
una tarea. Esas respuestas son el contenido técnico del proyecto.

Se eligió, entonces, la autonomía total **con trazabilidad obligatoria**: cada decisión se
toma sin intervención humana pero queda registrada con los datos, los umbrales y el
razonamiento que la produjeron.

## 7. Limitaciones asumidas

Enunciarlas es parte del planteo, no un descargo.

- **Un veredicto automático desfavorable no tiene apelación.** El sistema mitiga el riesgo
  —ningún cierre irreversible en el primer intento, los fallos de infraestructura nunca se
  computan como rechazo— pero no lo elimina.
- **La calidad del plan depende del modelo.** Un objetivo ambiguo produce un grafo pobre. Se
  mitiga con validación estricta y auto-reparación, no se resuelve.
- **Sin pagos, el incentivo del proveedor es externo al sistema.** La reputación funciona
  como moneda dentro de la plataforma, pero la motivación real queda fuera del alcance.

---

**Uso de IA y autoría.** Este documento se elaboró con asistencia de Claude (Anthropic,
modelo `claude-opus-5`). Las decisiones de diseño, la revisión y la verificación son de los
autores, que asumen la responsabilidad sobre su contenido. Constancia formal en
[`11-declaracion-de-uso-de-ia.md`](11-declaracion-de-uso-de-ia.md).
