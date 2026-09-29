/**
 * VEKTORA · FASE 6 — Vocabulario visual de los estados.
 *
 * El color en esta interfaz significa ESTADO de tarea, y nada más. Por eso la traducción
 * vive en un solo sitio: si cada vista eligiera su propio tono, el grafo dejaría de poder
 * leerse de un vistazo, que es su única razón de existir.
 *
 * Los identificadores replican los ENUM de la base. Añadir una etiqueta allí obliga a
 * añadirla aquí, o la interfaz mostrará un estado sin nombre.
 */

export type EstadoTarea =
  | 'blocked'
  | 'ready'
  | 'open'
  | 'matching'
  | 'assigned'
  | 'in_progress'
  | 'submitted'
  | 'in_review'
  | 'revision_requested'
  | 'approved'
  | 'cancelled'
  | 'failed';

export interface Presentacion {
  etiqueta: string;
  color: string;
  /** Qué hay que hacer, o qué está esperando el sistema. Se muestra al pasar el cursor. */
  ayuda: string;
}

const SIN_NOMBRE: Presentacion = {
  etiqueta: 'desconocido',
  color: 'var(--color-apagado)',
  ayuda: 'Estado no reconocido por la interfaz.',
};

const TAREAS: Record<EstadoTarea, Presentacion> = {
  blocked: {
    etiqueta: 'bloqueada',
    color: 'var(--color-bloqueada)',
    ayuda: 'Espera a que se apruebe alguna de sus dependencias.',
  },
  ready: {
    etiqueta: 'lista',
    color: 'var(--color-lista)',
    ayuda: 'Sin dependencias pendientes: se puede adjudicar.',
  },
  open: {
    etiqueta: 'abierta',
    color: 'var(--color-lista)',
    ayuda: 'Abierta a candidaturas.',
  },
  matching: {
    etiqueta: 'emparejando',
    color: 'var(--color-emparejando)',
    ayuda: 'Hay candidaturas puntuadas; ninguna superó todavía el umbral de adjudicación.',
  },
  assigned: {
    etiqueta: 'asignada',
    color: 'var(--color-asignada)',
    ayuda: 'Adjudicada a un proveedor, a la espera de la entrega.',
  },
  in_progress: {
    etiqueta: 'en curso',
    color: 'var(--color-asignada)',
    ayuda: 'El proveedor está trabajando en ella.',
  },
  submitted: {
    etiqueta: 'entregada',
    color: 'var(--color-entregada)',
    ayuda: 'Entregada y en cola de evaluación automática.',
  },
  in_review: {
    etiqueta: 'en evaluación',
    color: 'var(--color-entregada)',
    ayuda: 'El evaluador automático la está juzgando ahora mismo.',
  },
  revision_requested: {
    etiqueta: 'con cambios pedidos',
    color: 'var(--color-revision)',
    ayuda: 'El evaluador pidió cambios: el proveedor puede corregir y volver a entregar.',
  },
  approved: {
    etiqueta: 'aprobada',
    color: 'var(--color-aprobada)',
    ayuda: 'Aprobada. Las tareas que dependían de ella ya se desbloquearon.',
  },
  cancelled: {
    etiqueta: 'cancelada',
    color: 'var(--color-apagado)',
    ayuda: 'Cancelada; no se ejecutará.',
  },
  failed: {
    etiqueta: 'fallida',
    color: 'var(--color-fallida)',
    ayuda: 'Se agotaron los intentos de revisión y la tarea se cerró sin aprobarse.',
  },
};

export function presentarTarea(estado: string): Presentacion {
  return TAREAS[estado as EstadoTarea] ?? SIN_NOMBRE;
}

/** Orden de progreso, para ordenar leyendas y resúmenes de forma estable. */
export const ORDEN_TAREA: EstadoTarea[] = [
  'blocked',
  'ready',
  'open',
  'matching',
  'assigned',
  'in_progress',
  'submitted',
  'in_review',
  'revision_requested',
  'approved',
  'failed',
  'cancelled',
];

const QA: Record<string, Presentacion> = {
  pending: {
    etiqueta: 'en cola',
    color: 'var(--color-entregada)',
    ayuda: 'Esperando al evaluador automático.',
  },
  running: {
    etiqueta: 'evaluando',
    color: 'var(--color-emparejando)',
    ayuda: 'El evaluador lo tiene tomado ahora mismo.',
  },
  approved: {
    etiqueta: 'aprobado',
    color: 'var(--color-aprobada)',
    ayuda: 'Cumple todos los criterios de aceptación.',
  },
  rejected: {
    etiqueta: 'rechazado',
    color: 'var(--color-fallida)',
    ayuda: 'No cumple los criterios y se agotaron los intentos.',
  },
  revision_requested: {
    etiqueta: 'cambios pedidos',
    color: 'var(--color-revision)',
    ayuda: 'Se puede corregir y volver a entregar.',
  },
  error: {
    etiqueta: 'error del evaluador',
    color: 'var(--color-apagado)',
    ayuda: 'Falló la infraestructura de IA. No cuenta como rechazo: se puede reintentar.',
  },
};

export function presentarQa(estado: string): Presentacion {
  return QA[estado] ?? SIN_NOMBRE;
}

export function presentarProyecto(estado: string): string {
  const nombres: Record<string, string> = {
    draft: 'borrador',
    planning: 'planificando',
    planned: 'planificado',
    active: 'en curso',
    paused: 'en pausa',
    completed: 'completado',
    cancelled: 'cancelado',
    failed: 'fallido',
  };
  return nombres[estado] ?? estado;
}
