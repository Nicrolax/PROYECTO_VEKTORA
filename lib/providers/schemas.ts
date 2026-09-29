/**
 * VEKTORA · FASE 3.5 — Contrato de alta de proveedor.
 *
 * Mismo criterio que en el planificador: los invariantes viven en el esquema, no en
 * comprobaciones dispersas por el código. Aquí además protegen la calidad del matching —
 * un `headline` de tres palabras produce un embedding inútil, y un perfil sin skills no es
 * emparejable con nada.
 */

import { z } from 'zod';

/** Slug canónico: minúsculas, dígitos y guiones simples. Igual que `skills.slug`. */
export const SKILL_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Umbral de similitud coseno para mapear un slug propuesto a una skill existente.
 *
 * MEDIDO, no estimado. `npm run skills:calibrate` sobre el catálogo de 30 skills dio:
 * el par de skills DISTINTAS más parecido (`market-research` ~ `ux-research`) llega a
 * 0.9220, y los sinónimos reales medidos en altas (`next-js`~`nextjs`,
 * `postgres`~`postgresql`) rondan 0.99. 0.95 cae limpio en ese hueco.
 *
 * El valor anterior, 0.82, fusionaba el 76.8% de los pares del catálogo.
 */
export const DEFAULT_SKILL_MATCH_THRESHOLD = 0.95;

export const MIN_SKILLS = 1;
export const MAX_SKILLS = 20;

/**
 * Espejo en TypeScript de `public.normalize_skill_slug`. Se normaliza en el cliente ANTES
 * de consultar para que `React 18` y `react-18` colapsen sin gastar una ida a la base.
 * Si las dos implementaciones divergen, la de la base manda: es la que decide.
 */
export function normalizeSkillSlug(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '');
}

export const ProposedSkillSchema = z.strictObject({
  /** Lo que escribió el proveedor. Puede no ser un slug: se normaliza y se resuelve. */
  slug: z.string().trim().min(2).max(80),
  /** Nombre legible, por si hay que crear la skill. */
  name: z.string().trim().min(2).max(120).optional(),
  level: z.number().int().min(1).max(5).default(3),
  yearsExperience: z.number().min(0).max(60).optional(),
});

export type ProposedSkill = z.infer<typeof ProposedSkillSchema>;

export const ProviderProfileInputSchema = z.strictObject({
  headline: z
    .string()
    .trim()
    .min(10)
    .max(160)
    .describe('Qué hace, en una línea. Es la señal más fuerte del embedding.'),
  summary: z
    .string()
    .trim()
    .min(40)
    .max(4000)
    .describe('Experiencia y alcance. Cuanto más concreto, mejor empareja.'),
  seniority: z.enum(['junior', 'mid', 'senior', 'lead', 'principal']).optional(),
  hourlyRateUsd: z.number().min(0).max(10_000).optional(),
  minTaskBudgetUsd: z.number().min(0).max(1_000_000).optional(),
  availabilityHoursWeek: z.number().int().min(0).max(168).optional(),
  languages: z.array(z.string().trim().min(2).max(40)).max(12).default([]),
  timezone: z.string().trim().min(2).max(64).optional(),
  isActive: z.boolean().default(true),
  /**
   * Consentimiento explícito a la asignación automática. En un sistema sin gestión humana,
   * adjudicar trabajo a quien no lo pidió no es autonomía, es atropello.
   */
  acceptsAutoAssign: z.boolean().default(true),
});

export type ProviderProfileInput = z.infer<typeof ProviderProfileInputSchema>;

export const PersonProfileInputSchema = z.strictObject({
  fullName: z.string().trim().min(2).max(120).optional(),
  displayName: z.string().trim().min(2).max(80).optional(),
  countryCode: z
    .string()
    .trim()
    .length(2)
    .regex(/^[A-Za-z]{2}$/, 'código ISO 3166-1 alfa-2')
    .optional(),
  timezone: z.string().trim().min(2).max(64).optional(),
  locale: z.string().trim().min(2).max(10).optional(),
  bio: z.string().trim().max(4000).optional(),
  websiteUrl: z.string().url().max(500).optional(),
});

export type PersonProfileInput = z.infer<typeof PersonProfileInputSchema>;

export const RegisterProviderSchema = z
  .strictObject({
    /** Cuenta existente en `public.users`. Excluyente con `email`. */
    userId: z.string().uuid().optional(),
    /** Alternativa: localizar la cuenta por correo. */
    email: z.string().email().optional(),
    person: PersonProfileInputSchema.optional(),
    provider: ProviderProfileInputSchema,
    skills: z.array(ProposedSkillSchema).min(MIN_SKILLS).max(MAX_SKILLS),
    /** Vectoriza el perfil para el matching de la FASE 4. Por defecto sí. */
    embedProfile: z.boolean().default(true),
    /** Sobrescribe el umbral de similitud para esta alta. */
    skillMatchThreshold: z.number().min(0).max(1).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.userId === undefined && value.email === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['userId'],
        message:
          'hay que indicar userId o email: el proveedor tiene que corresponder a una cuenta ' +
          'existente de public.users',
      });
    }

    // Dos entradas que normalizan al mismo slug son la misma skill declarada dos veces.
    const seen = new Map<string, number>();
    value.skills.forEach((skill, index) => {
      const normalized = normalizeSkillSlug(skill.slug);
      if (normalized === '') {
        ctx.addIssue({
          code: 'custom',
          path: ['skills', index, 'slug'],
          message: `"${skill.slug}" queda vacío tras normalizar; usa letras o dígitos`,
        });
        return;
      }
      const first = seen.get(normalized);
      if (first !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['skills', index, 'slug'],
          message: `"${skill.slug}" y "${value.skills[first]?.slug}" son la misma skill ("${normalized}")`,
        });
        return;
      }
      seen.set(normalized, index);
    });
  });

export type RegisterProviderInput = z.input<typeof RegisterProviderSchema>;
export type RegisterProviderData = z.infer<typeof RegisterProviderSchema>;
