# Documentación del proyecto VEKTORA

Programación Avanzada — UTU. Esta carpeta contiene los entregables documentales exigidos por
los *Lineamientos de Evaluación*, uno por archivo.

| Documento | Aspecto evaluado | Puntos |
|---|---|---|
| [`01-desarrollo-teorico.md`](01-desarrollo-teorico.md) | Resolución de la situación problema | 10 |
| [`02-requisitos.md`](02-requisitos.md) | Requisitos funcionales y no funcionales | 5 |
| [`03-stack-tecnologico.md`](03-stack-tecnologico.md) | Stack tecnológico | 5 |
| [`04-diagrama-de-clases.md`](04-diagrama-de-clases.md) | Diagrama UML | 5 |
| [`05-casos-de-uso.md`](05-casos-de-uso.md) | Casos de uso | 5 |
| [`06-infraestructura.md`](06-infraestructura.md) | Diagrama de infraestructura | 5 |

Los otros 65 puntos se evalúan sobre el código y su ejecución:

| Aspecto | Dónde se sustenta | Puntos |
|---|---|---|
| Coherencia stack ↔ código | `03-stack-tecnologico.md` frente a `package.json` | 10 |
| Análisis estático | Código fuente bajo `app/`, `lib/`, `scripts/`, `db/`, `tests/` | 20 |
| Prueba de funcionalidad real | Los requisitos funcionales de `02-requisitos.md` | 35 |

## Qué es VEKTORA

Una plataforma de coordinación de proyectos por objetivos en la que **las tres decisiones de
gestión —descomponer, asignar y aceptar— las toman agentes de inteligencia artificial**, sin
intervención humana intermedia y dejando registrada la explicación de cada una.

El cliente aporta un objetivo en lenguaje natural y un presupuesto. El sistema lo convierte
en un grafo acíclico de tareas con criterios de aceptación, adjudica cada tarea al proveedor
más adecuado, evalúa lo entregado contra esos criterios y desbloquea las tareas siguientes.
Nadie aprueba nada por el camino.

## Documentos auxiliares

| Archivo | Para qué |
|---|---|
| [`07-repositorio-y-auditoria.md`](07-repositorio-y-auditoria.md) | Preparación del repositorio y del análisis estático |
| [`08-estado-de-implementacion.md`](08-estado-de-implementacion.md) | Estado de las siete fases, puesta en marcha y guion de demostración |
| [`09-despliegue.md`](09-despliegue.md) | Puesta en producción en Supabase y Vercel, paso a paso |
| [`10-guia-para-el-equipo.md`](10-guia-para-el-equipo.md) | **Cómo funciona el proyecto en palabras simples.** Para quien no escribió el código |
| [`11-declaracion-de-uso-de-ia.md`](11-declaracion-de-uso-de-ia.md) | **Declaración formal de uso de IA y de autoría.** Modelos empleados y alcance de lo declarado |

La documentación técnica detallada de cada fase de desarrollo —decisiones de diseño, errores
encontrados y cómo se corrigieron— vive fuera de esta carpeta, en el espacio de trabajo del
proyecto.

---

**Uso de IA y autoría.** Este documento se elaboró con asistencia de Claude (Anthropic,
modelo `claude-opus-5`). Las decisiones de diseño, la revisión y la verificación son de los
autores, que asumen la responsabilidad sobre su contenido. Constancia formal en
[`11-declaracion-de-uso-de-ia.md`](11-declaracion-de-uso-de-ia.md).
