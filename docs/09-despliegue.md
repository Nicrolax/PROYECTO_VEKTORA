# Guía de despliegue

Dos servicios y ninguno cuesta nada: **Supabase** guarda los datos, **Vercel** sirve la
aplicación web. Se despliegan en ese orden, porque Vercel necesita las claves de Supabase.

## 1. Base de datos (Supabase)

Desde el **SQL Editor** del proyecto, ejecutar en este orden. Cada guion depende del
anterior y todos son idempotentes: se pueden reaplicar sin destruir datos.

| # | Archivo | Qué aporta |
|---|---|---|
| 1 | `db/schema.sql` | 14 ENUM, 15 tablas, disparadores del grafo, 44 políticas de acceso |
| 2 | `db/migrations/0002_planner.sql` | Persistencia transaccional del plan y avance del grafo |
| 3 | `db/migrations/0003_provider_onboarding.sql` | Catálogo vivo de habilidades |
| 4 | `db/migrations/0004_matching.sql` | Recuperación de candidatos y adjudicación |
| 5 | `db/migrations/0005_qa.sql` | Evaluación automática de entregables |
| 6 | `db/migrations/0006_realtime.sql` | Publicación de cambios en vivo |
| 7 | `db/migrations/0007_escalada.sql` | Escalada del emparejamiento y cuotas de uso |
| 8 | `db/seeds/01_skills.sql` | Catálogo inicial de habilidades |

Después, desde la máquina de desarrollo:

```bash
npm run skills:embed   # vectoriza el catálogo; sin esto no hay normalización semántica
npm run db:check       # confirma que está todo lo que el código necesita
```

### Autenticación

En **Authentication → Providers → Email**:

- **Producción: dejar activado «Confirm email».** Es lo que garantiza que las direcciones
  sean reales, y el código lo complementa rechazando dominios desechables al registrarse.
- Solo se desactiva para probar en local, donde esperar un correo entorpece.

En **Authentication → URL Configuration**, poner la URL de Vercel como *Site URL* y añadirla
a las *Redirect URLs*. Sin eso, el enlace de confirmación devuelve a `localhost`.

## 2. Aplicación web (Vercel)

1. Subir el repositorio a GitHub.
2. En Vercel, **Add New → Project** e importar ese repositorio. Next.js se detecta solo; no
   hay que tocar los comandos de compilación.
3. Cargar las variables de entorno (sección siguiente).
4. **Deploy.**

Los trabajos programados se configuran solos desde `vercel.json`, que ya está en el
repositorio:

| Trabajo | Cuándo | Qué hace |
|---|---|---|
| `/api/cron/emparejar` | 09:00 UTC | Adjudica las tareas disponibles |
| `/api/cron/evaluar` | 09:30 UTC | Juzga los entregables en cola |

**Esos dos relojes son lo que hace autónomo al sistema.** Sin ellos, una tarea que queda
lista espera a que alguien ejecute algo, y eso es intervención humana aunque se llame
«pulsar un botón». En desarrollo se suplen con `npm run cron`.

### Por qué una vez al día y no cada quince minutos

El plan gratuito de Vercel admite **una sola ejecución diaria por trabajo programado**. Un
`vercel.json` que pida `*/15 * * * *` no es que corra despacio: el despliegue entero se
rechaza con «Hobby accounts are limited to daily cron jobs».

La frecuencia es una restricción del plan, no del diseño. Lo que hace autónomo al sistema es
que **nadie decide**, no cada cuánto corre el reloj: el emparejador elige proveedor y el
evaluador cierra tareas sin que intervenga una persona, den la vuelta cada diez minutos o una
vez al día. Por eso también la escalada se cuenta en RONDAS y no en horas (ver
`lib/matching/config.ts`): con el reloj diario, cuatro rondas serían cuatro días, y así puede
demostrarse ejecutando `npm run cron` cuatro veces seguidas.

Para una demostración en vivo, `npm run cron` dispara los mismos endpoints HTTP con el mismo
secreto. No simula nada: es el mismo código que ejecuta el reloj.

## 3. Variables de entorno

`env.example` documenta cada una con su motivo. Las imprescindibles:

| Variable | De dónde sale | Quién la ve |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase → Settings → API | El navegador. Pública por diseño |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase → Settings → API Keys | El navegador. Pública por diseño |
| `SUPABASE_URL` | La misma URL | Solo el servidor |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Settings → API Keys | **Solo el servidor** |
| `GROQ_API_KEY` | console.groq.com | Solo el servidor |
| `GOOGLE_AI_API_KEY` | aistudio.google.com | Solo el servidor |
| `CRON_SECRET` | `openssl rand -hex 32` | Solo el servidor |

### La distinción que importa

`SUPABASE_SERVICE_ROLE_KEY` **bypassea todas las políticas de acceso**. Es la identidad de
los agentes autónomos y no puede llegar nunca al navegador. El prefijo `NEXT_PUBLIC_` es
precisamente lo que marca la frontera: Next.js incluye en el paquete del cliente todo lo que
lo lleve, y nada de lo que no.

Por eso la clave anónima **sí** lleva el prefijo: es pública a propósito, y la seguridad la
dan las 44 políticas de acceso por fila, no el secreto de la clave.

`CRON_SECRET` tampoco es público. Quien lo tenga puede ejecutar a los agentes con
privilegios plenos. Sin él configurado, los disparadores responden 503 y no corren: un
despliegue mal configurado que deja a los agentes expuestos es peor que uno donde el ciclo
automático está apagado.

## 4. Comprobación posterior

```bash
npm run db:check    # el despliegue tiene lo que el código necesita
npm run ai:models   # los modelos configurados siguen existiendo
npm run ai:check    # la capa de IA responde contra las APIs reales
```

**El segundo importa más de lo que parece.** Los proveedores retiran modelos:
`llama-3.3-70b-versatile` y `gemini-2.5-flash` se dieron de baja durante el desarrollo y
empezaron a devolver 404. El sistema trata ese error como de configuración y dice qué hacer,
pero conviene enterarse antes de una demostración, no durante.

## 5. Límites del free tier

| Servicio | Límite relevante | Qué pasa al alcanzarlo |
|---|---|---|
| Supabase | Proyecto en pausa tras inactividad | Se reactiva desde el panel |
| Vercel | Duración máxima de función | Planificar ronda los 25 s; el máximo declarado es 60 |
| Groq | Peticiones por minuto y por día | La cadena cede al respaldo de Google |
| Google AI | Peticiones por minuto y por día | La operación se degrada; nunca se rechaza a nadie por esto |

Las cuotas por usuario (`VEKTORA_QUOTA_*`) existen para que una persona no agote el free
tier de todas las demás. Por defecto: 5 proyectos, 10 altas de proveedor y 30 entregas cada
24 horas.

## 6. Recuperación de incidentes

| Síntoma | Causa probable | Solución |
|---|---|---|
| «no reconoce el modelo» | El proveedor lo retiró | `npm run ai:models` y actualizar `GROQ_MODEL` / `GOOGLE_AI_MODEL` |
| El grafo no se actualiza solo | Falta la migración 0006 | Aplicar `db/migrations/0006_realtime.sql` |
| Los trabajos devuelven 503 | Falta `CRON_SECRET` | Definirla y volver a desplegar |
| Los trabajos devuelven 401 | El secreto no coincide | Igualar el de Vercel y el de `.env.local` |
| Una tarea no se adjudica nunca | Ningún candidato supera el umbral | Se resuelve sola tras 4 rondas; ver la escalada |
| Planificar da tiempo agotado | Límite de duración de función | Comprobar `maxDuration = 60` en la página |
