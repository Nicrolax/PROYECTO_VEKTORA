'use server';

/**
 * VEKTORA · FASE 6 — Alta y edición de proveedor (RF-3.1, RF-3.2, RF-3.6).
 *
 * El alta siempre se hace sobre la cuenta de la sesión: `userId` sale del servidor, nunca
 * del formulario. Si viniera del cliente, cualquiera podría crear un perfil a nombre de otro
 * y recibir sus adjudicaciones.
 *
 * La resolución de habilidades se devuelve a la interfaz para que el proveedor VEA a qué
 * entrada del catálogo se mapeó cada término que escribió. Sin eso, la normalización
 * semántica es magia invisible: alguien escribe «next js», el sistema lo resuelve como
 * `nextjs`, y nadie se entera de que ocurrió.
 */

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { errorMessage } from '@/lib/ai/errors';
import { requireUserOrThrow } from '@/lib/auth/session';
import { consumirCuota } from '@/lib/cuotas';
import { createProviderOnboarding } from '@/lib/providers';
import { validarTextoSustantivo } from '@/lib/validacion/entrada';

const HabilidadSchema = z.object({
  slug: z.string().trim().min(2).max(80),
  level: z.number().int().min(1).max(5),
  yearsExperience: z.number().min(0).max(60).optional(),
});

const AltaSchema = z.object({
  headline: z
    .string()
    .trim()
    .min(10, 'El titular necesita al menos 10 caracteres')
    .max(160, 'El titular es demasiado largo'),
  summary: z
    .string()
    .trim()
    .min(40, 'Contá tu experiencia con al menos 40 caracteres: es lo que empareja')
    .max(4000, 'El resumen es demasiado largo'),
  hourlyRateUsd: z.number().min(0).max(10_000).optional(),
  minTaskBudgetUsd: z.number().min(0).max(1_000_000).optional(),
  availabilityHoursWeek: z.number().int().min(0).max(168).optional(),
  acceptsAutoAssign: z.boolean(),
  skills: z.array(HabilidadSchema).min(1, 'Declará al menos una habilidad').max(20),
});

export interface ResolucionVista {
  escrito: string;
  resuelto: string;
  origen: string;
  similitud: number | null;
}

export interface ResultadoAlta {
  ok: boolean;
  error: string | null;
  resoluciones: ResolucionVista[];
}

function numeroOpcional(valor: FormDataEntryValue | null): number | undefined {
  if (typeof valor !== 'string' || valor.trim() === '') return undefined;
  const numero = Number(valor);
  return Number.isFinite(numero) ? numero : undefined;
}

export async function registrarProveedor(
  _estadoPrevio: ResultadoAlta,
  formData: FormData,
): Promise<ResultadoAlta> {
  const user = await requireUserOrThrow();

  // Las habilidades llegan como filas paralelas: slug[], nivel[], años[].
  const slugs = formData.getAll('skill_slug').filter((v): v is string => typeof v === 'string');
  const niveles = formData.getAll('skill_level');
  const anios = formData.getAll('skill_years');

  const skills = slugs
    .map((slug, indice) => ({
      slug: slug.trim(),
      level: Number(niveles[indice] ?? 3),
      yearsExperience: numeroOpcional(anios[indice] ?? null),
    }))
    .filter((skill) => skill.slug !== '');

  const parsed = AltaSchema.safeParse({
    headline: formData.get('headline'),
    summary: formData.get('summary'),
    hourlyRateUsd: numeroOpcional(formData.get('hourlyRateUsd')),
    minTaskBudgetUsd: numeroOpcional(formData.get('minTaskBudgetUsd')),
    availabilityHoursWeek: numeroOpcional(formData.get('availabilityHoursWeek')),
    acceptsAutoAssign: formData.get('acceptsAutoAssign') === 'si',
    skills,
  });

  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? 'Los datos no son válidos',
      resoluciones: [],
    };
  }

  // El resumen es lo que se vectoriza y con lo que se empareja: si no dice nada, el
  // proveedor acaba emparejado con cualquier cosa o con nada.
  const resumen = validarTextoSustantivo(parsed.data.summary, {
    minPalabras: 8,
    minPalabrasDistintas: 6,
  });
  if (!resumen.valido) return { ok: false, error: resumen.motivo, resoluciones: [] };

  const cuota = await consumirCuota(user.id, 'alta_proveedor');
  if (!cuota.permitido) return { ok: false, error: cuota.mensaje, resoluciones: [] };

  try {
    const resultado = await createProviderOnboarding().register({
      userId: user.id,
      provider: {
        headline: parsed.data.headline,
        summary: parsed.data.summary,
        acceptsAutoAssign: parsed.data.acceptsAutoAssign,
        ...(parsed.data.hourlyRateUsd === undefined
          ? {}
          : { hourlyRateUsd: parsed.data.hourlyRateUsd }),
        ...(parsed.data.minTaskBudgetUsd === undefined
          ? {}
          : { minTaskBudgetUsd: parsed.data.minTaskBudgetUsd }),
        ...(parsed.data.availabilityHoursWeek === undefined
          ? {}
          : { availabilityHoursWeek: parsed.data.availabilityHoursWeek }),
      },
      skills: parsed.data.skills.map((skill) => ({
        slug: skill.slug,
        level: skill.level,
        ...(skill.yearsExperience === undefined ? {} : { yearsExperience: skill.yearsExperience }),
      })),
    });

    revalidatePath('/proveedor');

    return {
      ok: true,
      error: null,
      resoluciones: resultado.skills.map((resolucion) => ({
        escrito: resolucion.proposed,
        resuelto: resolucion.slug,
        origen: resolucion.match,
        similitud: resolucion.similarity,
      })),
    };
  } catch (error) {
    return { ok: false, error: errorMessage(error), resoluciones: [] };
  }
}
