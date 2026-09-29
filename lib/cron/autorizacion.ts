/**
 * VEKTORA · FASE 6 — Autorización de los trabajos programados.
 *
 * Estos disparadores ejecutan a los agentes autónomos con la clave de servicio y sin ninguna
 * sesión de usuario, así que son la superficie más sensible de la aplicación: quien pueda
 * invocarlos consume cuota de IA ajena y mueve reputación. La única defensa es un secreto
 * compartido con el planificador de tareas del despliegue.
 *
 * La comparación es en tiempo constante. Comparar con `===` filtra información por el tiempo
 * que tarda en devolver `false`, y un secreto se puede adivinar carácter a carácter con
 * suficientes intentos.
 */

import { timingSafeEqual } from 'node:crypto';

export type ResultadoAutorizacion =
  | { autorizado: true }
  | { autorizado: false; motivo: string; estado: 401 | 503 };

export function igualSeguro(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');
  // `timingSafeEqual` exige la misma longitud, y esa comprobación sí revela el tamaño del
  // secreto. Es información inocua comparada con revelar su contenido.
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}

export function autorizarCron(
  cabeceras: Headers,
  entorno: Record<string, string | undefined> = process.env,
): ResultadoAutorizacion {
  const esperado = entorno['CRON_SECRET'];

  // Sin secreto configurado NO se abre la puerta: se cierra. Un despliegue mal configurado
  // que deja a los agentes expuestos es peor que uno donde los trabajos no corren.
  if (esperado === undefined || esperado.trim() === '') {
    return {
      autorizado: false,
      estado: 503,
      motivo:
        'CRON_SECRET no está configurado. Los trabajos programados quedan desactivados ' +
        'hasta que se defina: ejecutarlos sin autenticación expondría a los agentes.',
    };
  }

  const cabecera = cabeceras.get('authorization') ?? '';
  const prefijo = 'Bearer ';
  const recibido = cabecera.startsWith(prefijo) ? cabecera.slice(prefijo.length) : '';

  if (recibido === '' || !igualSeguro(recibido, esperado)) {
    return { autorizado: false, estado: 401, motivo: 'No autorizado' };
  }

  return { autorizado: true };
}
