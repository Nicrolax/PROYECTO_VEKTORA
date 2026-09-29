# Stack tecnológico

Cada tecnología va acompañada del motivo concreto por el que se eligió. Fuente de verdad:
`package.json` y `tsconfig.json` del repositorio.

## Lenguaje y ejecución

| Tecnología | Versión | Por qué se eligió |
|---|---|---|
| **TypeScript** | 7.0.2 | El dominio es un grafo con invariantes (aciclicidad, presupuestos que suman exacto, estados de tarea). El tipado estático permite expresar esos contratos y que el compilador los verifique. Se usa en modo `strict` más `noUncheckedIndexedAccess` y `exactOptionalPropertyTypes`: acceder a `array[i]` obliga a tratar el `undefined`, que es la fuente habitual de errores al recorrer grafos. |
| **Node.js** | ≥ 20.11 | Runtime del servidor. Aporta `fetch` nativo, lo que evita añadir un cliente HTTP como dependencia. |
| **tsx** | 4.23 | Ejecuta TypeScript sin paso de compilación para los guiones de operación y mantenimiento. |

## Framework y presentación

| Tecnología | Versión | Por qué se eligió |
|---|---|---|
| **Next.js** (App Router) | 15 | Un solo proyecto para interfaz y servidor. Los **Server Actions** son decisivos aquí: permiten invocar a los agentes autónomos desde el servidor sin exponer al navegador la clave `service_role`, que bypassea las políticas de seguridad. Los **Route Handlers** dan el punto de entrada para los trabajos programados. |
| **React** | 19 | Modelo de componentes de la interfaz; es el que Next.js integra. |
| **Tailwind CSS** | 4 | Estilos por utilidades, sin hojas de estilo separadas que se desincronizan del marcado. Reduce el CSS a escribir y mantiene la coherencia visual sin un sistema de diseño propio. |
| **shadcn/ui** | — | Componentes accesibles (diálogos, tablas, formularios) que se copian al proyecto en lugar de instalarse como dependencia: quedan bajo control del equipo y del análisis estático, no ocultos en `node_modules`. |
| **Lucide** | — | Iconografía coherente, ligera y tratable como componentes React. |

## Persistencia

| Tecnología | Versión | Por qué se eligió |
|---|---|---|
| **PostgreSQL** | 16.13 | El modelo es relacional con integridad fuerte: claves foráneas, restricciones CHECK y **disparadores** que impiden estados imposibles —como un ciclo en el grafo de tareas— aunque el código de aplicación falle. |
| **pgvector** | 0.6.0 | Búsqueda por similitud semántica dentro de la misma base que los datos relacionales. La alternativa —una base vectorial aparte— obligaría a sincronizar dos fuentes para un volumen que no lo justifica. Se usa con índices HNSW parciales y distancia coseno. |
| **Supabase** | Free tier | PostgreSQL gestionado con autenticación y Row Level Security integradas, dentro de la restricción de infraestructura gratuita. Aporta `auth.users`, las políticas de acceso y el rol `service_role` para los agentes autónomos. |
| **@supabase/supabase-js** | 2.116 | Cliente oficial. Se usa deliberadamente solo para consultas simples y llamadas a funciones: **toda operación que deba ser atómica está escrita en PL/pgSQL**, porque el cliente no ofrece transacciones de varias sentencias. |

## Validación e inteligencia artificial

| Tecnología | Versión | Por qué se eligió |
|---|---|---|
| **Zod** | 4.6.3 | Valida la salida de los modelos de lenguaje, que es texto sin garantías, y las entradas de los formularios. Más importante: los invariantes del dominio se expresan como refinamientos, de modo que un error de validación produce un mensaje accionable que se le devuelve al modelo para que se corrija solo. |
| **Groq API** | `openai/gpt-oss-120b` | Proveedor primario de generación. Free tier y latencia baja. |
| **Google AI Studio** | `gemini-3.6-flash` | Proveedor de respaldo automático ante fallo o cuota agotada del primario. |
| **Google AI Studio** | `gemini-embedding-001` | Vectorización a 1536 dimensiones para la búsqueda semántica de proveedores y tareas. |

> Los nombres de modelo son **configuración, no arquitectura**: caducan. `llama-3.3-70b-versatile`
> y `gemini-2.5-flash` se retiraron durante el desarrollo y empezaron a devolver 404. El
> sistema trata ese 404 como error de configuración y `npm run ai:models` consulta qué
> modelos admite cada clave.

## Despliegue

| Tecnología | Por qué se eligió |
|---|---|
| **Vercel** (free tier) | Despliegue nativo de Next.js con red de distribución. Sus **trabajos programados** son lo que hace que el sistema sea realmente autónomo: disparan el emparejamiento y la evaluación sin que nadie ejecute un comando. |
| **Supabase** (free tier) | Base de datos, autenticación y almacenamiento, ya descritos arriba. |

## Pruebas y verificación

| Tecnología | Versión | Por qué se eligió |
|---|---|---|
| **Vitest** | 5.0 | Ejecuta TypeScript nativamente y comparte la resolución de rutas del proyecto. Cubre la lógica de decisión sin red ni base de datos, que es donde el sistema puede equivocarse en silencio. |
| **PostgreSQL local + pgvector** | 16 | Las funciones SQL se verifican por comportamiento sobre una base desechable antes de aplicarse en Supabase (`db/verify/`). |

## Coherencia entre lo declarado y lo implementado

Toda tecnología de esta lista aparece en `package.json` o en la configuración de despliegue
del repositorio entregado. `08-estado-de-implementacion.md` registra en qué fase se incorpora
cada una y el estado de verificación de esa fase.
