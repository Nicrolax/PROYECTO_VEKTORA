# Requisitos funcionales y no funcionales

Cada requisito funcional está redactado en términos de **comportamiento observable del
sistema** e indica cómo se demuestra. Los no funcionales llevan criterio medible.

## Requisitos funcionales

### RF-1 · Acceso e identidad

| # | El sistema debe… | Cómo se demuestra |
|---|---|---|
| RF-1.1 | Permitir el registro y el inicio de sesión mediante correo electrónico | Alta desde el navegador y acceso al panel |
| RF-1.2 | Crear automáticamente el perfil de usuario al confirmarse la cuenta | La fila aparece en el listado de usuarios sin intervención |
| RF-1.3 | Mostrar a cada usuario únicamente sus propios proyectos, candidaturas y entregables | Dos sesiones simultáneas ven conjuntos de datos distintos |
| RF-1.4 | Permitir que un mismo usuario actúe como cliente y como proveedor | Un usuario con proyectos propios y perfil de proveedor activo |

### RF-2 · Planificación de proyectos

| # | El sistema debe… | Cómo se demuestra |
|---|---|---|
| RF-2.1 | Permitir al cliente crear un proyecto indicando un objetivo en lenguaje natural y un presupuesto | Formulario de creación en el navegador |
| RF-2.2 | Descomponer el objetivo en entre 2 y 24 tareas con título, descripción, habilidades requeridas, esfuerzo estimado y prioridad | El grafo aparece poblado al terminar la planificación |
| RF-2.3 | Generar para cada tarea entre 1 y 6 criterios de aceptación verificables sin intervención humana | Panel de detalle de cualquier tarea |
| RF-2.4 | Rechazar y reescribir automáticamente todo criterio que dependa de la acción de una persona | Ningún criterio del grafo exige aprobación o firma de alguien |
| RF-2.5 | Garantizar que el grafo de dependencias sea acíclico, reparándolo si el modelo produce un ciclo | El visualizador nunca muestra un ciclo; las correcciones quedan registradas |
| RF-2.6 | Repartir el presupuesto entre las tareas de modo que la suma coincida exactamente con el total | El total de la vista de proyecto iguala al presupuesto declarado |
| RF-2.7 | Marcar como disponibles las tareas sin dependencias y como bloqueadas el resto | Colores de estado en el visualizador del grafo |
| RF-2.8 | Mostrar el avance de la planificación mientras ocurre | Indicador de progreso durante la creación |

### RF-3 · Alta de proveedores

| # | El sistema debe… | Cómo se demuestra |
|---|---|---|
| RF-3.1 | Permitir registrarse como proveedor declarando perfil, habilidades con nivel y años, tarifa y disponibilidad | Formulario de alta de proveedor |
| RF-3.2 | Normalizar cada habilidad contra el catálogo: coincidencia exacta, alias conocido, similitud semántica o creación de una nueva | El formulario muestra a qué habilidad del catálogo se resolvió cada término escrito |
| RF-3.3 | Registrar el mapeo de una habilidad resuelta por similitud, para que la siguiente coincidencia sea exacta | Escribir el mismo sinónimo dos veces resuelve igual sin recalcular |
| RF-3.4 | Vectorizar el perfil del proveedor para la búsqueda semántica | El proveedor aparece como candidato en tareas afines |
| RF-3.5 | Permitir declarar si se acepta adjudicación automática y el presupuesto mínimo por tarea | Ajustes del perfil de proveedor |
| RF-3.6 | Permitir al proveedor modificar sus habilidades después del alta | Los cambios se reflejan en emparejamientos posteriores |

### RF-4 · Emparejamiento y adjudicación

| # | El sistema debe… | Cómo se demuestra |
|---|---|---|
| RF-4.1 | Recuperar proveedores elegibles para una tarea combinando búsqueda vectorial y filtros de elegibilidad | Lista de candidatos en el panel de la tarea |
| RF-4.2 | Excluir al propietario del proyecto, a quien no acepta adjudicación automática y a quien exige un presupuesto mínimo mayor que el de la tarea | Los descartados se muestran con el motivo |
| RF-4.3 | Puntuar cada candidato combinando afinidad semántica, cobertura de habilidades y reputación | Desglose de los tres componentes por candidato |
| RF-4.4 | Aplicar un valor neutro de reputación a quien no tiene historial, de modo que pueda recibir su primera adjudicación | Un proveedor recién registrado aparece y puede ganar |
| RF-4.5 | Seguir funcionando, sin componente semántico, cuando falten vectores | Aviso de modo degradado en el panel |
| RF-4.6 | Registrar cada candidatura con la explicación completa de su puntuación | Explicación consultable desde la interfaz |
| RF-4.7 | Adjudicar la tarea al mejor candidato cuando supere el umbral, y rechazar el resto en la misma operación | La tarea pasa a asignada y el resto de candidaturas a rechazadas |
| RF-4.8 | Explicar qué filtro excluyó a cada proveedor cuando no queda ningún candidato | Mensaje explicativo en lugar de una lista vacía |
| RF-4.9 | Emparejar automáticamente y de forma periódica las tareas disponibles, sin que nadie lo solicite | Una tarea que queda disponible se adjudica sola en el siguiente ciclo |

### RF-5 · Entrega de trabajo

| # | El sistema debe… | Cómo se demuestra |
|---|---|---|
| RF-5.1 | Ofrecer al proveedor un espacio de entrega con los criterios de aceptación a la vista | Vista de trabajo de una tarea asignada |
| RF-5.2 | Permitir adjuntar resumen, contenido, artefactos y evidencia asociada a cada criterio | Formulario de entrega |
| RF-5.3 | Versionar automáticamente cada entrega de una misma tarea | La segunda entrega figura como versión 2 |
| RF-5.4 | Advertir si la evidencia aportada no cubre todos los criterios de aceptación | Aviso antes de confirmar la entrega |
| RF-5.5 | Reflejar el cambio de estado de la tarea al entregarse | El estado cambia a entregado en el visualizador |

### RF-6 · Evaluación automática

| # | El sistema debe… | Cómo se demuestra |
|---|---|---|
| RF-6.1 | Evaluar cada criterio de aceptación por separado, citando la evidencia que lo sustenta | Desglose por criterio en la vista de veredicto |
| RF-6.2 | Calcular el veredicto global con una política determinista, no con el criterio del modelo | Los umbrales aplicados se muestran junto al resultado |
| RF-6.3 | No aprobar un entregable que no aporte evidencia alguna | Una entrega vacía nunca resulta aprobada |
| RF-6.4 | Distinguir «no se cumple» de «no se puede verificar», y pedir revisión en el segundo caso | Los tres veredictos posibles son visibles por criterio |
| RF-6.5 | Dejar el entregable reintentable, nunca rechazado, cuando falle la infraestructura de IA | Un fallo del proveedor de modelos no penaliza al proveedor de trabajo |
| RF-6.6 | Impedir que dos evaluaciones simultáneas juzguen el mismo entregable | Dos ejecuciones a la vez producen un solo veredicto |
| RF-6.7 | Registrar veredicto, reseña, reputación y nuevo estado de la tarea en una única operación indivisible | No existe estado intermedio observable |
| RF-6.8 | No acreditar dos veces la misma reputación por el mismo entregable | Reevaluar no altera la puntuación acumulada |
| RF-6.9 | Cerrar una tarea tras agotar el máximo de intentos de revisión | La tarea pasa a fallida tras el tercer intento |
| RF-6.10 | Evaluar automáticamente y de forma periódica los entregables en cola | Una entrega recibe veredicto sin que nadie lo solicite |
| RF-6.11 | Notificar al proveedor el veredicto con el resumen accionable | Aviso visible al iniciar sesión |

### RF-7 · Avance del proyecto y reputación

| # | El sistema debe… | Cómo se demuestra |
|---|---|---|
| RF-7.1 | Desbloquear automáticamente las tareas cuyas dependencias hayan sido aprobadas | El visualizador refleja el cambio sin recargar |
| RF-7.2 | Volver a bloquear las tareas dependientes si una tarea aprobada se reabre | Cambio de color en cascada en el grafo |
| RF-7.3 | Marcar el proyecto como completado cuando todas sus tareas estén aprobadas | Estado del proyecto en el panel |
| RF-7.4 | Mantener un registro de reputación inmutable del que se pueda reconstruir toda puntuación | Historial de eventos en el perfil del proveedor |
| RF-7.5 | Mostrar al proveedor su reputación con el detalle de los eventos que la componen | Vista de perfil |

### RF-8 · Paneles y visualización

| # | El sistema debe… | Cómo se demuestra |
|---|---|---|
| RF-8.1 | Mostrar el grafo de tareas de forma interactiva, con estado, dependencias y proveedor asignado | Visualizador del proyecto |
| RF-8.2 | Permitir abrir cualquier tarea para ver criterios, candidaturas, entregables y veredicto | Navegación desde el grafo |
| RF-8.3 | Ofrecer al cliente un panel con sus proyectos, su avance y su presupuesto consumido | Panel de cliente |
| RF-8.4 | Ofrecer al proveedor un panel con sus tareas asignadas, entregas y reputación | Panel de proveedor |
| RF-8.5 | Reflejar los cambios de estado en vivo, sin recargar la página | Dos ventanas abiertas se actualizan a la vez |
| RF-8.6 | Mostrar el consumo de la capa de IA por proyecto: operaciones, proveedor, estado y coste | Vista de observabilidad |

## Requisitos no funcionales

### Rendimiento

| # | Requisito | Criterio medible |
|---|---|---|
| RNF-1.1 | La recuperación de candidatos usa un índice vectorial aproximado | Índice HNSW parcial sobre el vector del perfil; la consulta filtra los nulos y ordena por distancia coseno |
| RNF-1.2 | El emparejamiento de una tarea se resuelve en menos de 5 s con el vector ya calculado | Medido: 1907–2191 ms |
| RNF-1.3 | La evaluación de un entregable se resuelve en menos de 10 s | Medido: 2283–7112 ms |
| RNF-1.4 | La planificación de un proyecto completo se resuelve en menos de 60 s | Medido: 24 s para un grafo de 10 tareas |
| RNF-1.5 | Toda operación de varias escrituras se ejecuta en una sola ida y vuelta a la base | Cuatro funciones transaccionales cubren los cuatro casos |
| RNF-1.6 | El fallo de un proveedor de IA no interrumpe la operación | Cadena de respaldo con reintentos exponenciales que respeta la cabecera de espera |
| RNF-1.7 | La primera carga de una vista de proyecto no supera los 2 s | Renderizado en servidor y transferencia solo de los datos visibles |

### Seguridad

| # | Requisito | Criterio medible |
|---|---|---|
| RNF-2.1 | Todas las tablas tienen control de acceso a nivel de fila; la ausencia de política implica denegación | 44 políticas verificadas sobre PostgreSQL real |
| RNF-2.2 | El rol anónimo no puede ejecutar ninguna función de escritura del sistema | Verificado con comprobaciones de privilegio en las pruebas SQL |
| RNF-2.3 | Las credenciales nunca se versionan | Archivos de entorno y perfiles excluidos del control de versiones; la plantilla documenta cada variable sin valores |
| RNF-2.4 | La clave con privilegios plenos nunca llega al navegador | Solo se usa en servidor; el cliente administrador falla si detecta un entorno de navegador |
| RNF-2.5 | El registro de reputación es inmutable | Disparador que rechaza modificación y borrado |
| RNF-2.6 | Un usuario no puede escalar su propio rol ni modificar tareas ajenas | Disparadores de alcance sobre usuarios y tareas |
| RNF-2.7 | Toda entrada externa se valida contra un esquema antes de usarse | Validación estricta en configuración, formularios, salidas de modelos y veredictos |
| RNF-2.8 | Las rutas del servidor verifican la sesión antes de operar | Un acceso sin sesión a una acción de servidor es rechazado |

### Usabilidad

| # | Requisito | Criterio medible |
|---|---|---|
| RNF-3.1 | Un usuario nuevo puede crear su primer proyecto en menos de 3 minutos desde el alta | Recorrido de alta, creación y visualización sin documentación |
| RNF-3.2 | Toda decisión automática es consultable con su explicación desde la interfaz | Candidaturas y veredictos muestran el desglose completo |
| RNF-3.3 | Los errores indican la acción correctiva concreta, no solo que algo falló | Un modelo retirado indica cómo consultar los disponibles; cero candidatos explica qué filtro excluyó a quién |
| RNF-3.4 | Toda operación destructiva puede ensayarse sin escribir | Modo de ensayo en emparejamiento y evaluación |
| RNF-3.5 | La interfaz es utilizable desde un teléfono | Diseño adaptable verificado a 375 px de ancho |
| RNF-3.6 | Los elementos interactivos son accesibles por teclado y tienen contraste suficiente | Componentes accesibles y contraste mínimo 4.5:1 |
| RNF-3.7 | La interfaz está íntegramente en español | Revisión de textos de interfaz |

### Mantenibilidad y operación

| # | Requisito | Criterio medible |
|---|---|---|
| RNF-4.1 | El código compila sin errores en modo estricto | Comprobación de tipos con las tres opciones estrictas activadas |
| RNF-4.2 | La lógica de decisión está cubierta por pruebas automáticas sin red ni base de datos | Suite de pruebas del núcleo |
| RNF-4.3 | El comportamiento de las funciones SQL se verifica antes de aplicarlas en producción | Verificación sobre base local desechable |
| RNF-4.4 | Ningún módulo importa archivos internos de otro dominio | Importaciones solo por índices públicos |
| RNF-4.5 | Los umbrales y pesos son configurables sin tocar código | Variables de entorno documentadas una a una |
| RNF-4.6 | El despliegue se puede verificar antes de operar | Comprobaciones de base de datos y de capa de IA |
| RNF-4.7 | Los guiones SQL son idempotentes y reaplicables sin destruir datos | Verificado reaplicando cada migración |
| RNF-4.8 | Toda llamada a un modelo queda registrada con operación, proveedor, estado, tokens y coste | Tabla de corridas de IA |
