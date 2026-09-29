/**
 * VEKTORA · FASE 2 — Registro de capacidades de los modelos de embedding de
 * Google AI Studio (free tier). Todo lo de aquí es proveedor Google; no se usa OpenAI.
 *
 * Existe por una razón concreta: `outputDimensionality` de la API solo RECORTA el vector
 * (Matryoshka Representation Learning), nunca lo amplía. Pedir 1536 dimensiones a un
 * modelo de 768 devuelve un 400 en tiempo de ejecución. Este registro convierte ese fallo
 * en un error de configuración en el arranque, con mensaje accionable.
 *
 * Referencia: https://ai.google.dev/gemini-api/docs/embeddings
 */

export interface EmbeddingModelSpec {
  /** Dimensiones que produce el modelo sin reducir. */
  nativeDimensions: number;
  /** true si admite `outputDimensionality` para recortar por debajo del nativo. */
  supportsReduction: boolean;
  /** Tamaños que Google recomienda explícitamente. */
  recommendedDimensions: number[];
  /** Mínimo razonable antes de que la calidad se degrade sin remedio. */
  minDimensions: number;
  /**
   * Google indica renormalizar tras recortar con MRL: los vectores reducidos pierden la
   * norma unitaria y la distancia coseno deja de ser consistente.
   */
  requiresRenormalization: boolean;
  /** Fecha ISO de baja anunciada, si la hay. */
  deprecatedOn?: string;
  notes?: string;
}

export const EMBEDDING_MODELS: Record<string, EmbeddingModelSpec> = {
  'gemini-embedding-001': {
    nativeDimensions: 3072,
    supportsReduction: true,
    recommendedDimensions: [3072, 1536, 768],
    minDimensions: 128,
    requiresRenormalization: true,
    notes:
      'Modelo vigente de Google AI Studio. 1536 conserva ~99% de la calidad de 3072 y es ' +
      'el tamaño que usa `vector(1536)` en db/schema.sql.',
  },
  'text-embedding-004': {
    nativeDimensions: 768,
    supportsReduction: true,
    recommendedDimensions: [768],
    minDimensions: 128,
    requiresRenormalization: true,
    deprecatedOn: '2026-01-14',
    notes:
      'Modelo de 768 dimensiones, dado de baja el 2026-01-14. No puede producir 1536: ' +
      'outputDimensionality solo recorta. Usarlo obliga a migrar el schema a vector(768).',
  },
};

export interface EmbeddingModelValidation {
  ok: boolean;
  /** Mensaje accionable cuando `ok` es false. */
  error?: string;
  /** Aviso no bloqueante (modelo desconocido, modelo deprecado, tamaño no recomendado). */
  warning?: string;
  spec?: EmbeddingModelSpec;
}

/** Comprueba que el par (modelo, dimensiones) sea físicamente posible. */
export function validateEmbeddingModel(
  model: string,
  dimensions: number,
): EmbeddingModelValidation {
  const spec = EMBEDDING_MODELS[model];

  if (spec === undefined) {
    return {
      ok: true,
      warning:
        `AI_EMBEDDING_MODEL="${model}" no está en el registro de VEKTORA. Se aceptan ` +
        `${dimensions} dimensiones sin validar; el adaptador verificará el tamaño real de ` +
        'la respuesta y fallará si no coincide.',
    };
  }

  if (dimensions > spec.nativeDimensions) {
    return {
      ok: false,
      spec,
      error:
        `El modelo "${model}" produce ${spec.nativeDimensions} dimensiones y ` +
        `outputDimensionality solo recorta (MRL), nunca amplía: no puede dar ` +
        `${dimensions}. Opciones: (a) usar "gemini-embedding-001", que soporta ` +
        `${EMBEDDING_MODELS['gemini-embedding-001']?.recommendedDimensions.join('/')} ` +
        `dimensiones; o (b) fijar AI_EMBEDDING_DIMENSIONS=${spec.nativeDimensions} y ` +
        `migrar db/schema.sql a vector(${spec.nativeDimensions}).`,
    };
  }

  if (!spec.supportsReduction && dimensions !== spec.nativeDimensions) {
    return {
      ok: false,
      spec,
      error:
        `El modelo "${model}" no admite reducción de dimensiones: debe usarse con ` +
        `AI_EMBEDDING_DIMENSIONS=${spec.nativeDimensions}.`,
    };
  }

  if (dimensions < spec.minDimensions) {
    return {
      ok: false,
      spec,
      error:
        `${dimensions} dimensiones está por debajo del mínimo razonable ` +
        `(${spec.minDimensions}) para "${model}".`,
    };
  }

  const warnings: string[] = [];
  if (spec.deprecatedOn !== undefined) {
    warnings.push(
      `"${model}" fue dado de baja el ${spec.deprecatedOn}; migrar a "gemini-embedding-001".`,
    );
  }
  if (!spec.recommendedDimensions.includes(dimensions)) {
    warnings.push(
      `${dimensions} no está entre los tamaños recomendados para "${model}" ` +
        `(${spec.recommendedDimensions.join(', ')}).`,
    );
  }

  return {
    ok: true,
    spec,
    ...(warnings.length > 0 ? { warning: warnings.join(' ') } : {}),
  };
}

/** Descripción legible del modelo activo; la usa `scripts/ai-check.ts`. */
export function describeEmbeddingModel(model: string, dimensions: number): string {
  const spec = EMBEDDING_MODELS[model];
  if (spec === undefined) return `${model} @ ${dimensions} dims (modelo no registrado)`;
  const reduced = dimensions < spec.nativeDimensions ? ` (recortado desde ${spec.nativeDimensions} vía MRL)` : '';
  return `${model} @ ${dimensions} dims${reduced}`;
}
