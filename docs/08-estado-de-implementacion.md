# Estado de implementación y guion de demostración

## Fases

| Fase | Alcance | Estado |
|---|---|---|
| 1 | Modelo de datos, pgvector, disparadores del grafo, políticas de acceso | Completa y verificada |
| 2 | Capa de abstracción de IA con respaldo automático y auto-reparación | Completa y verificada |
| 3 | Planificador de proyectos (objetivo → grafo) | Completa y verificada |
| 3.5 | Alta de proveedores y catálogo vivo de habilidades | Completa y verificada |
| 4 | Motor de emparejamiento híbrido | Completa y verificada |
| 5 | Agente autónomo de evaluación | Completa y verificada |
| 6 | Interfaz web y paneles | Completa y verificada |
| 7 | Escalada, cuotas, validación reforzada, observabilidad y despliegue | Completa y verificada |

**Los 51 requisitos funcionales y los 30 no funcionales de `02-requisitos.md` están
implementados.** El ciclo completo —planificar, adjudicar, entregar, evaluar, desbloquear—
funciona desde el navegador y desde la línea de comandos, sin ninguna decisión humana
intermedia.

Comprobado sobre el despliegue real: comprobación de tipos estricta limpia, **315 pruebas en
15 archivos**, compilación de producción con 13 rutas, y los cinco archivos de verificación de
comportamiento de `db/verify/` en verde sobre una base creada desde cero.

## Puesta en marcha antes de una demostración

Dos ajustes de entorno, no de código:

- **«Confirm email» activado en Supabase.** Se desactiva solo para poder probar sin esperar
  correos; en cualquier despliegue real va activado.
- **Dos cuentas.** El dueño de un proyecto no puede ser proveedor de sus propias tareas —es un
  filtro deliberado— así que con una sola cuenta nunca se llega a ver una adjudicación.

## Guion

1. Entrar como cliente y crear un proyecto. Mostrar la barra de progreso: está llamando al
   modelo, validando el grafo y vectorizando cada tarea.
2. En el visualizador, señalar que **la columna de cada tarea es su profundidad real en el
   grafo**, no una posición estética, y que el color es el estado.
3. Abrir una tarea: criterios de aceptación escritos antes de que nadie trabaje.
4. Disparar el emparejamiento (`npm run cron` en local, o esperar al reloj en producción).
   Abrir la candidatura y mostrar el desglose: afinidad, habilidades, reputación.
5. Entrar con la segunda cuenta, ir al espacio de entrega y entregar con evidencia por
   criterio.
6. Disparar la evaluación. Mostrar el veredicto criterio a criterio **con la evidencia
   citada**.
7. Volver al grafo: las tareas que dependían de la aprobada pasaron a disponibles solas.
8. Abrir **Consumo de IA** y mostrar el coste, los tokens y si hubo respaldo de proveedor.

El paso 7 es el sistema entero: nadie aprobó nada en todo el recorrido.

## Comprobación previa

```bash
npm run verify      # tipos estrictos + suite de pruebas
npm run build       # compilación de producción
npm run db:check    # el despliegue tiene lo que el código necesita
npm run ai:models   # los modelos configurados siguen existiendo
```

Los cuatro tienen que pasar. El último importa más de lo que parece: los modelos se retiran, y
uno retirado convierte una demostración en vivo en un error 404.

---

**Uso de IA y autoría.** Este documento se elaboró con asistencia de Claude (Anthropic,
modelo `claude-opus-5`). Las decisiones de diseño, la revisión y la verificación son de los
autores, que asumen la responsabilidad sobre su contenido. Constancia formal en
[`11-declaracion-de-uso-de-ia.md`](11-declaracion-de-uso-de-ia.md).
