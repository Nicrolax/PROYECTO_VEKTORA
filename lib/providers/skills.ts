/**
 * VEKTORA · FASE 3.5 — Resolución de skills contra el catálogo vivo.
 *
 * Cascada de cuatro pasos, de más barato a más caro:
 *
 *   1. slug EXACTO          una consulta por lote, sin red externa
 *   2. alias ya registrado   una consulta por lote, sin red externa
 *   3. vecino semántico      un embedding por slug desconocido + `<=>` en la base
 *   4. creación              solo si nada se parece lo suficiente
 *
 * Los dos primeros pasos son lo que hace viable esto en un free tier: la segunda vez que
 * alguien escribe `reactjs`, el alias ya existe y no se gasta ni una llamada a Google.
 *
 * Si los embeddings no están disponibles, el paso 3 se salta: la resolución degrada a
 * exacto + alias + creación. Se degrada, no se falla.
 */

import { getEmbeddingService, toPgVector, type EmbeddingService } from '@/lib/ai/embeddings';
import { errorMessage, isAiError } from '@/lib/ai/errors';
import { DEFAULT_SKILL_MATCH_THRESHOLD, normalizeSkillSlug } from './schemas';
import type { ProviderRepository, ResolvedSkill } from './repository';

export interface SkillProposal {
  slug: string;
  name?: string | undefined;
}

export interface SkillResolverOptions {
  repository: ProviderRepository;
  /** `null` desactiva el paso semántico de forma explícita (útil en pruebas). */
  embeddings?: EmbeddingService | null;
  threshold?: number;
}

export interface ResolveSkillsResult {
  resolved: ResolvedSkill[];
  /** Cuántos slugs necesitaron un embedding. Mide el gasto real del free tier. */
  embedded: number;
  /** true si el paso semántico se saltó por no haber embeddings disponibles. */
  degraded: boolean;
}

/** Umbral efectivo: parámetro > variable de entorno > constante del dominio. */
export function resolveThreshold(explicit?: number): number {
  if (explicit !== undefined && Number.isFinite(explicit)) return explicit;
  const fromEnv = Number(process.env['VEKTORA_SKILL_MATCH_THRESHOLD']);
  if (Number.isFinite(fromEnv) && fromEnv > 0 && fromEnv <= 1) return fromEnv;
  return DEFAULT_SKILL_MATCH_THRESHOLD;
}

/**
 * Texto que representa la skill en el espacio vectorial.
 * Se incluye el nombre legible además del slug porque `llm-integration` y
 * `Integración de LLMs` no se parecen como cadenas pero sí como concepto, y es el concepto
 * lo que hay que comparar.
 */
export function renderSkillForEmbedding(slug: string, name?: string): string {
  const readable = name ?? slug.replace(/-/g, ' ');
  return `Competencia profesional: ${readable} (${slug})`;
}

export class SkillResolver {
  private readonly repository: ProviderRepository;
  private readonly embeddings: EmbeddingService | null;
  private readonly threshold: number;

  constructor(options: SkillResolverOptions) {
    this.repository = options.repository;
    this.embeddings =
      options.embeddings !== undefined ? options.embeddings : getEmbeddingService();
    this.threshold = resolveThreshold(options.threshold);
  }

  async resolve(proposals: readonly SkillProposal[]): Promise<ResolveSkillsResult> {
    if (proposals.length === 0) return { resolved: [], embedded: 0, degraded: false };

    // Se normaliza en el cliente para que dos formas de escribir lo mismo colapsen antes
    // de consultar. La base vuelve a normalizar: es ella quien decide.
    const normalized = proposals.map((proposal) => ({
      ...proposal,
      normalized: normalizeSkillSlug(proposal.slug),
    }));
    const slugs = [...new Set(normalized.map((entry) => entry.normalized))].filter(
      (slug) => slug !== '',
    );

    // --- Pasos 1 y 2: dos consultas por lote -------------------------------------------
    const [exactRows, aliasMap] = await Promise.all([
      this.repository.findSkillsBySlugs(slugs),
      this.repository.findSkillsByAliases(slugs),
    ]);
    const exactMap = new Map(exactRows.map((row) => [row.slug.toLowerCase(), row]));

    // El resultado se devuelve EN EL ORDEN DE ENTRADA. `ProviderOnboarding` empareja cada
    // skill declarada con su resolución por índice, así que reordenar aquí le colgaría el
    // nivel y los años de experiencia a la skill equivocada, sin que nada fallara.
    const slots: Array<ResolvedSkill | null> = normalized.map(() => null);
    const pending: Array<{ index: number; normalized: string; name?: string | undefined }> = [];

    normalized.forEach((entry, index) => {
      const exact = exactMap.get(entry.normalized);
      if (exact !== undefined) {
        slots[index] = {
          proposed: entry.normalized,
          skillId: exact.id,
          slug: exact.slug,
          name: exact.name,
          category: exact.category,
          match: 'exact',
          similarity: 1,
        };
        return;
      }

      const alias = aliasMap.get(entry.normalized);
      if (alias !== undefined) {
        slots[index] = {
          proposed: entry.normalized,
          skillId: alias.id,
          slug: alias.slug,
          name: alias.name,
          category: alias.category,
          match: 'alias',
          similarity: null,
        };
        return;
      }

      pending.push({ index, normalized: entry.normalized, name: entry.name });
    });

    const collect = (): ResolvedSkill[] =>
      slots.filter((slot): slot is ResolvedSkill => slot !== null);

    if (pending.length === 0) return { resolved: collect(), embedded: 0, degraded: false };

    // --- Paso 3: un embedding por slug desconocido ---------------------------------------
    let vectors: string[] | null = null;
    let degraded = false;

    if (this.embeddings !== null && this.embeddings.isAvailable()) {
      try {
        const response = await this.embeddings.embedTexts({
          texts: pending.map((entry) => renderSkillForEmbedding(entry.normalized, entry.name)),
          // El catálogo se vectoriza como documento, así que la consulta también debe serlo:
          // mezclar RETRIEVAL_QUERY con RETRIEVAL_DOCUMENT desplaza la geometría y las
          // similitudes dejan de ser comparables con el umbral calibrado.
          taskType: 'RETRIEVAL_DOCUMENT',
        });
        vectors = response.vectors.map((vector) => toPgVector(vector, response.dimensions));
      } catch (error) {
        degraded = true;
        const detail = isAiError(error) ? error.code : errorMessage(error);
        console.warn(
          `[vektora/skills] sin paso semántico (${detail}): se resolverá por slug exacto ` +
            'y se crearán las skills nuevas',
        );
      }
    } else {
      degraded = true;
    }

    // --- Pasos 3 y 4 en la base ------------------------------------------------------------
    let embedded = 0;
    for (let position = 0; position < pending.length; position += 1) {
      const entry = pending[position];
      if (entry === undefined) continue;
      const vector = vectors?.[position];
      if (vector !== undefined) embedded += 1;

      const outcome = await this.repository.resolveOrCreateSkill({
        slug: entry.normalized,
        name: entry.name,
        vector,
        threshold: this.threshold,
      });
      slots[entry.index] = { proposed: entry.normalized, ...outcome };
    }

    return { resolved: collect(), embedded, degraded };
  }
}

/** Resumen legible de cómo se resolvió cada skill. Lo usan los scripts. */
export function describeResolution(resolved: readonly ResolvedSkill[]): string[] {
  return resolved.map((skill) => {
    switch (skill.match) {
      case 'exact':
        return `${skill.proposed} -> ${skill.slug} (exacta)`;
      case 'alias':
        return `${skill.proposed} -> ${skill.slug} (alias ya conocido)`;
      case 'semantic':
        return `${skill.proposed} -> ${skill.slug} (semántica, ${(skill.similarity ?? 0).toFixed(3)})`;
      case 'created':
        return `${skill.proposed} -> ${skill.slug} (NUEVA en el catálogo)`;
    }
  });
}
