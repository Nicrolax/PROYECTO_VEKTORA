# Declaración de uso de inteligencia artificial y de autoría

## 1. Alcance

Esta declaración deja constancia formal del uso de herramientas de inteligencia artificial
en el proyecto VEKTORA, y delimita la autoría y la responsabilidad sobre el trabajo
presentado. Alcanza a la totalidad del repositorio: código fuente, esquema de base de datos,
pruebas automatizadas y documentación.

## 2. Autoría

Autores, por orden alfabético de apellido:

- Nicolás Bentancour
- Agustín Perdomo
- Matías Piñeyro
- Thiago Rodríguez

Los autores declaran que el proyecto es de **elaboración propia**, en el sentido que se
precisa en la sección 5: las decisiones de diseño, la dirección del desarrollo, la revisión
del código y la verificación de los resultados son suyas, y asumen la responsabilidad íntegra
sobre el contenido presentado.

## 3. Dos usos distintos de la IA, que no deben confundirse

En este proyecto la inteligencia artificial aparece en dos planos separados. Distinguirlos es
necesario para que la declaración sea precisa.

### 3.1. La IA como herramienta de desarrollo

Se utilizó un asistente de programación para redactar código y documentación bajo la
dirección de los autores.

| | |
|---|---|
| **Herramienta** | Claude, de Anthropic |
| **Modelo** | `claude-opus-5` |
| **Interfaces** | Aplicación de escritorio de Claude y Claude Code |
| **Empleado para** | Redacción de código fuente, esquema SQL, pruebas automatizadas y documentación; revisión de código; diagnóstico de errores |

### 3.2. La IA como componente del sistema

VEKTORA **es**, en sí mismo, un sistema construido sobre modelos de lenguaje: son el
mecanismo que convierte un objetivo escrito en un grafo de tareas y el que evalúa los
entregables. Esto no es asistencia al desarrollo, sino el objeto del trabajo.

| Función | Proveedor | Modelo |
|---|---|---|
| Planificación y evaluación (principal) | Groq | `openai/gpt-oss-120b` |
| Planificación y evaluación (respaldo automático) | Google AI Studio | `gemini-3.6-flash` |
| Vectorización de textos | Google AI Studio | `gemini-embedding-001` |

La arquitectura de esta capa está documentada en
[`03-stack-tecnologico.md`](03-stack-tecnologico.md) e implementada en `lib/ai/`.

## 4. Qué aportó la herramienta y qué aportaron los autores

| Aportado por la herramienta de IA | Aportado por los autores |
|---|---|
| Redacción del código a partir de especificaciones | Definición del problema, del alcance y de las siete fases |
| Propuestas de implementación y de estructura | Decisión sobre cuáles adoptar, cuáles modificar y cuáles descartar |
| Redacción de las pruebas automatizadas | Criterio sobre qué debía probarse |
| Borradores de la documentación | Contenido, enfoque y validación de lo afirmado |
| Diagnóstico de errores | Ejecución contra servicios reales y detección de los fallos |

## 5. Alcance de la afirmación de autoría

Los autores no afirman haber escrito manualmente cada línea del repositorio. Afirman algo
distinto y verificable:

1. **La concepción del sistema es propia.** El problema, el alcance, la división en fases y
   las restricciones de diseño —autonomía total, infraestructura gratuita, ausencia de
   simulaciones— fueron definidos por los autores.
2. **Las decisiones de diseño son propias.** Cada decisión relevante fue evaluada y adoptada
   por los autores, y está documentada con su justificación en `docs/` y en los comentarios
   del código.
3. **La verificación es propia.** El sistema fue ejecutado contra servicios reales —base de
   datos, proveedores de IA, despliegue— y los fallos encontrados en esas ejecuciones
   motivaron correcciones documentadas. Varias de las decisiones del código existen
   precisamente porque una ejecución real demostró que la alternativa fallaba.
4. **La comprensión del sistema es propia.** Los autores pueden explicar y defender cualquier
   parte del repositorio.

## 6. Constancia verificable

Lo declarado en la sección 5 no es una afirmación sin respaldo. Puede comprobarse en:

- **El historial del repositorio**, que registra el avance fase por fase.
- **Las 315 pruebas automatizadas** de `tests/` y las comprobaciones de comportamiento sobre
  PostgreSQL de `db/verify/`.
- **Los comentarios del código**, que explican el porqué de cada decisión no evidente y, en
  varios casos, el fallo concreto que la motivó.
- **Las constantes de `lib/matching/config.ts`**, que están medidas sobre datos reales
  mediante `npm run skills:calibrate` y documentan de dónde sale cada valor.

## 7. Declaración final

Los autores declaran haber utilizado herramientas de inteligencia artificial como asistencia
en la elaboración de este proyecto, en los términos descritos, y dejan constancia de ello de
forma expresa. Declaran asimismo que el trabajo presentado responde a su propia concepción,
dirección y criterio, que comprenden su funcionamiento en su totalidad, y que asumen la
responsabilidad plena sobre su contenido.
