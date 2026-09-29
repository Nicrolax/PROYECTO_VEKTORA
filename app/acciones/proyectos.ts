'use server';

/**
 * VEKTORA · FASE 6 — Acciones de proyecto (RF-2.1).
 *
 * Aquí se cruza la frontera de privilegios: la acción valida la sesión con la clave anónima
 * y, solo después, invoca al planificador, que opera con la clave de servicio. Ese orden es
 * la garantía de que nadie planifica proyectos a nombre de otro. Una acción de servidor es
 * un punto de entrada HTTP como cualquier otro: sin la comprobación previa, bastaría conocer
 * su identificador para invocarla.
 */

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { errorMessage } from '@/lib/ai/errors';
import { requireUserOrThrow } from '@/lib/auth/session';
import { consumirCuota } from '@/lib/cuotas';
import { createProjectPlanner } from '@/lib/planner';
import { validarPresupuesto, validarTextoSustantivo } from '@/lib/validacion/entrada';

const CrearProyectoSchema = z.object({
  objective: z
    .string()
    .trim()
    .min(20, 'Describí el objetivo con al menos 20 caracteres: el planificador necesita contexto')
    .max(2000, 'El objetivo es demasiado largo'),
  budgetTotal: z
    .number({ error: 'El presupuesto tiene que ser un número' })
    .positive('El presupuesto tiene que ser mayor que cero')
    .max(1_000_000, 'El presupuesto excede el máximo admitido'),
});

export interface ResultadoCrear {
  ok: boolean;
  error: string | null;
}

export async function crearProyecto(
  _estadoPrevio: ResultadoCrear,
  formData: FormData,
): Promise<ResultadoCrear> {
  const user = await requireUserOrThrow();

  const presupuestoCrudo = formData.get('budgetTotal');
  const parsed = CrearProyectoSchema.safeParse({
    objective: formData.get('objective'),
    budgetTotal: typeof presupuestoCrudo === 'string' ? Number(presupuestoCrudo) : Number.NaN,
  });

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Los datos no son válidos' };
  }

  // Zod ya comprobó tipos y longitudes. Esto comprueba que haya CONTENIDO: un objetivo de
  // 60 caracteres que repite la misma palabra pasa el primer filtro, cuesta una llamada al
  // modelo igual, y produce un plan inventado en vez de uno malo.
  const objetivo = validarTextoSustantivo(parsed.data.objective, {
    minPalabras: 6,
    minPalabrasDistintas: 5,
  });
  if (!objetivo.valido) return { ok: false, error: objetivo.motivo };

  const presupuesto = validarPresupuesto(parsed.data.budgetTotal);
  if (!presupuesto.valido) return { ok: false, error: presupuesto.motivo };

  // La cuota se consume ANTES de llamar al modelo. Al revés, un usuario podría agotar la
  // cuota de IA de todos y solo después enterarse de que había llegado a su límite.
  const cuota = await consumirCuota(user.id, 'crear_proyecto');
  if (!cuota.permitido) return { ok: false, error: cuota.mensaje };

  let projectId: string;
  try {
    const resultado = await createProjectPlanner().planProject({
      create: {
        ownerId: user.id,
        objective: parsed.data.objective,
        budgetTotal: parsed.data.budgetTotal,
      },
    });
    projectId = resultado.project.id;
  } catch (error) {
    // El mensaje del dominio ya explica qué hacer (por ejemplo, que el modelo configurado
    // se retiró). Envolverlo en un «algo salió mal» destruiría esa información.
    return { ok: false, error: errorMessage(error) };
  }

  revalidatePath('/panel');
  redirect(`/proyectos/${projectId}`);
}
