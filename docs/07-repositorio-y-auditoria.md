# Repositorio y análisis estático

## Publicar el repositorio

Los lineamientos exigen «código fuente del proyecto, en un repositorio accesible para el
docente». Desde la raíz del proyecto:

```bash
git init
git branch -M main
git add .
git status          # REVISAR antes de confirmar
git commit -m "VEKTORA: plataforma autonoma de resultados"
```

En `git status` **no debe aparecer** ninguno de estos:

- `.env.local` — contiene la clave que bypassea todas las políticas de acceso
- `perfil.json` — datos personales reales
- `node_modules/` — se reconstruye con `npm install`

Si alguno aparece, hay un problema en `.gitignore`: pararse y arreglarlo antes de confirmar.
**Un secreto confirmado queda en el historial aunque se borre después**, y el análisis
estático lo marca como hallazgo crítico.

Después, crear el repositorio remoto y publicarlo:

```bash
git remote add origin <url-del-repositorio>
git push -u origin main
```

## Lo que el análisis estático va a mirar

El criterio penaliza como **crítico**: inyección SQL, credenciales expuestas y ausencia total
de manejo de excepciones. Como **medio**: manejo de errores ausente en rutas clave y
validación de datos insuficiente.

| Riesgo | Situación |
|---|---|
| **Credenciales en el repositorio** | `.gitignore` excluye archivos de entorno y perfiles. `env.example` documenta cada variable **sin valores**. Ninguna clave aparece literal en el código. |
| **Inyección SQL** | No se concatena SQL en el código de aplicación. Todo acceso pasa por el cliente con parámetros o por funciones PL/pgSQL con argumentos tipados. Dentro de las funciones, los identificadores se manejan con `format(%I)`, nunca por concatenación. |
| **Manejo de excepciones** | Cada dominio define su clase de error (`PlannerError`, `MatchingError`, `QaError`, `AiError`, más un `*RepositoryError` por repositorio). Los guiones terminan en un `catch` que fija el código de salida. En la capa de IA la taxonomía de errores es además lo que decide si se reintenta o se cede al proveedor siguiente. |
| **Validación de datos** | Validación estricta en configuración, formularios, salidas de modelos y veredictos. Además, `lib/validacion/entrada.ts` comprueba que lo que llega tenga CONTENIDO: correos desechables, objetivos que repiten la misma palabra, presupuestos imposibles de repartir. |
| **Autorización** | Toda acción de servidor valida la sesión antes de operar. El navegador consulta con la clave anónima, sujeta a las políticas de acceso por fila. Los disparadores programados usan un secreto comparado en **tiempo constante**. |
| **Abuso de recursos** | Cuotas por usuario y ventana sobre las tres acciones que consumen IA. El recuento es atómico en la base: dos peticiones simultáneas no pueden consumir el mismo hueco. |
| **Duplicación y nombres** | Los cuatro dominios comparten deliberadamente la misma estructura (orquestador, interfaz de repositorio, implementación). Es repetición de *forma*, no de código. |

## Verificación antes de entregar

```bash
npm run verify      # comprobación de tipos estricta + suite de pruebas
npm run build       # compilación de producción
npm run db:check    # el despliegue tiene lo que el código necesita
npm run ai:models   # los modelos configurados siguen existiendo
```

Los cuatro tienen que pasar. El último importa más de lo que parece: un modelo retirado
convierte la demostración en vivo en un error 404.
