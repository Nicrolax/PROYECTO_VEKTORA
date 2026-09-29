/**
 * VEKTORA · FASE 7 — Cuotas de uso.
 *
 * Cada proyecto planificado cuesta una llamada a un modelo de lenguaje más una
 * vectorización por tarea. Sin tope, tres personas curiosas agotan el free tier en una
 * tarde y el sistema deja de funcionar para todos — incluida la demostración.
 *
 * El recuento vive en la base porque es el único sitio donde es atómico: dos pestañas
 * pulsando a la vez no pueden consumir el mismo hueco. Aquí solo se resuelven los límites
 * desde el entorno y se traduce el resultado a un mensaje que la persona entienda.
 */

import { z } from 'zod';
import { getSupabaseAdmin } from '@/lib/supabase/admin';

export type AccionLimitada = 'crear_proyecto' | 'alta_proveedor' | 'entregar';

export const CuotasSchema = z.object({
  /** Lo más caro del sistema: una llamada al modelo más una vectorización por tarea. */
  VEKTORA_QUOTA_PROYECTOS: z.coerce.number().int().min(0).max(1000).default(5),
  VEKTORA_QUOTA_PROYECTOS_HORAS: z.coerce.number().min(0.1).max(720).default(24),

  /** Una vectorización de perfil por alta, más las habilidades que haya que resolver. */
  VEKTORA_QUOTA_PROVEEDOR: z.coerce.number().int().min(0).max(1000).default(10),
  VEKTORA_QUOTA_PROVEEDOR_HORAS: z.coerce.number().min(0.1).max(720).default(24),

  /** Entregar es barato, pero cada entrega dispara una evaluación, que no lo es. */
  VEKTORA_QUOTA_ENTREGAS: z.coerce.number().int().min(0).max(1000).default(30),
  VEKTORA_QUOTA_ENTREGAS_HORAS: z.coerce.number().min(0.1).max(720).default(24),
});

export interface LimiteAccion {
  limite: number;
  ventanaHoras: number;
  /** Cómo se llama la acción cuando hay que explicarle al usuario que se pasó. */
  nombre: string;
}

export interface Cuotas {
  crear_proyecto: LimiteAccion;
  alta_proveedor: LimiteAccion;
  entregar: LimiteAccion;
}

export function cargarCuotas(env: Record<string, string | undefined> = process.env): Cuotas {
  const limpio: Record<string, string> = {};
  for (const [clave, valor] of Object.entries(env)) {
    if (typeof valor === 'string' && valor.trim() !== '') limpio[clave] = valor;
  }
  const v = CuotasSchema.parse(limpio);

  return {
    crear_proyecto: {
      limite: v.VEKTORA_QUOTA_PROYECTOS,
      ventanaHoras: v.VEKTORA_QUOTA_PROYECTOS_HORAS,
      nombre: 'crear proyectos',
    },
    alta_proveedor: {
      limite: v.VEKTORA_QUOTA_PROVEEDOR,
      ventanaHoras: v.VEKTORA_QUOTA_PROVEEDOR_HORAS,
      nombre: 'guardar tu perfil de proveedor',
    },
    entregar: {
      limite: v.VEKTORA_QUOTA_ENTREGAS,
      ventanaHoras: v.VEKTORA_QUOTA_ENTREGAS_HORAS,
      nombre: 'enviar entregas',
    },
  };
}

export interface ResultadoCuota {
  permitido: boolean;
  usados: number;
  limite: number;
  restantes: number;
  /** Mensaje listo para mostrar. `null` cuando la acción está permitida. */
  mensaje: string | null;
}

/** Cuánto falta para que se libere un hueco, en palabras. */
function enPalabras(disponibleEn: string | null, ventanaHoras: number): string {
  if (disponibleEn === null) return `Volvé a intentarlo en unas horas.`;
  const faltan = new Date(disponibleEn).getTime() - Date.now();
  if (!Number.isFinite(faltan) || faltan <= 0) return 'Ya podés volver a intentarlo.';

  const minutos = Math.ceil(faltan / 60_000);
  if (minutos < 60) return `Se libera un hueco en ${minutos} minuto${minutos === 1 ? '' : 's'}.`;
  const horas = Math.ceil(minutos / 60);
  if (horas < 24) return `Se libera un hueco en ${horas} hora${horas === 1 ? '' : 's'}.`;
  const dias = Math.ceil(horas / 24);
  return `Se libera un hueco en ${dias} día${dias === 1 ? '' : 's'} (ventana de ${ventanaHoras} h).`;
}

/**
 * Comprueba y consume un hueco. Devuelve el resultado; NO lanza.
 *
 * Si la base falla, se PERMITE la acción. Es una decisión deliberada: el límite existe para
 * proteger una cuota, no para custodiar nada crítico, y dejar a la gente sin poder trabajar
 * porque el contador no responde sería peor que el riesgo que evita.
 */
export async function consumirCuota(
  userId: string,
  accion: AccionLimitada,
  cuotas: Cuotas = cargarCuotas(),
): Promise<ResultadoCuota> {
  const limite = cuotas[accion];

  const { data, error } = await getSupabaseAdmin().rpc('consume_quota', {
    p_user_id: userId,
    p_action: accion,
    p_limit: limite.limite,
    p_window_hours: limite.ventanaHoras,
  });

  if (error !== null) {
    console.warn(`[vektora/cuota] no se pudo comprobar la cuota -> ${error.message}`);
    return {
      permitido: true,
      usados: 0,
      limite: limite.limite,
      restantes: limite.limite,
      mensaje: null,
    };
  }

  const fila = (data ?? {}) as Record<string, unknown>;
  const permitido = fila['permitido'] === true;
  const usados = Number(fila['usados'] ?? 0);

  if (permitido) {
    return {
      permitido: true,
      usados,
      limite: limite.limite,
      restantes: Number(fila['restantes'] ?? Math.max(0, limite.limite - usados)),
      mensaje: null,
    };
  }

  const disponibleEn =
    typeof fila['disponible_en'] === 'string' ? (fila['disponible_en'] as string) : null;

  return {
    permitido: false,
    usados,
    limite: limite.limite,
    restantes: 0,
    mensaje:
      limite.limite === 0
        ? `La opción de ${limite.nombre} está deshabilitada en esta instalación.`
        : `Llegaste al límite de ${limite.limite} para ${limite.nombre} cada ` +
          `${limite.ventanaHoras} horas. ${enPalabras(disponibleEn, limite.ventanaHoras)} ` +
          'El límite existe porque cada operación consume cuota de inteligencia artificial ' +
          'compartida.',
  };
}

/** Consumo actual sin consumir nada, para avisar antes de que la persona choque. */
export async function consultarCuota(
  userId: string,
  accion: AccionLimitada,
  cuotas: Cuotas = cargarCuotas(),
): Promise<{ usados: number; limite: number }> {
  const limite = cuotas[accion];
  const { data, error } = await getSupabaseAdmin().rpc('quota_usage', {
    p_user_id: userId,
    p_action: accion,
    p_window_hours: limite.ventanaHoras,
  });
  if (error !== null) return { usados: 0, limite: limite.limite };
  return { usados: Number(data ?? 0), limite: limite.limite };
}
