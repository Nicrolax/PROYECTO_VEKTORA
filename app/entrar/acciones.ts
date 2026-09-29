'use server';

/**
 * VEKTORA · FASE 6 — Alta y acceso (RF-1.1).
 *
 * Correo y contraseña, y no enlace mágico, por una razón operativa: el enlace mágico obliga
 * a salir de la aplicación, abrir el correo y volver. En una demostración en vivo eso es una
 * dependencia externa que puede fallar delante de todo el mundo.
 *
 * El perfil en `public.users` NO se crea aquí. Lo crea el disparador `handle_new_auth_user`
 * de la base al confirmarse la cuenta (RF-1.2): si dependiera de este código, un alta que
 * fallara a mitad dejaría una cuenta sin perfil.
 */

import { redirect } from 'next/navigation';
import { z } from 'zod';
import { getSupabaseServer } from '@/lib/supabase/server';
import { validarCorreo } from '@/lib/validacion/entrada';

/**
 * Al REGISTRARSE se exige un correo real; al ENTRAR no se comprueba nada de esto.
 *
 * La asimetría es deliberada: si endureciéramos también el inicio de sesión, alguien que se
 * registró antes de añadir un dominio a la lista quedaría fuera de su propia cuenta.
 */
const CORREO_ESTRICTO = { bloquearDesechables: true, bloquearReservados: true } as const;

const CredencialesSchema = z.object({
  email: z.string().trim().min(1, 'Falta el correo').pipe(z.email('El correo no es válido')),
  password: z.string().min(8, 'La contraseña necesita al menos 8 caracteres'),
});

function primerError(error: z.ZodError): string {
  return error.issues[0]?.message ?? 'Los datos no son válidos';
}

function volverConError(mensaje: string): never {
  redirect(`/entrar?error=${encodeURIComponent(mensaje)}`);
}

export async function iniciarSesion(formData: FormData): Promise<void> {
  const parsed = CredencialesSchema.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
  });
  if (!parsed.success) volverConError(primerError(parsed.error));

  const supabase = await getSupabaseServer();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);

  if (error !== null) {
    // Mensaje deliberadamente genérico: distinguir «no existe» de «contraseña incorrecta»
    // permitiría averiguar qué correos están registrados.
    volverConError('Correo o contraseña incorrectos');
  }

  redirect('/panel');
}

export async function registrarse(formData: FormData): Promise<void> {
  const parsed = CredencialesSchema.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
  });
  if (!parsed.success) volverConError(primerError(parsed.error));

  const correo = validarCorreo(parsed.data.email, CORREO_ESTRICTO);
  if (!correo.valido) volverConError(correo.motivo ?? 'El correo no es válido');

  const supabase = await getSupabaseServer();
  const { data, error } = await supabase.auth.signUp(parsed.data);

  if (error !== null) volverConError(error.message);

  // Sin sesión inmediata significa que el proyecto exige confirmar el correo.
  if (data.session === null) {
    redirect(
      `/entrar?aviso=${encodeURIComponent(
        'Cuenta creada. Confirmá el correo que te enviamos y volvé a entrar.',
      )}`,
    );
  }

  redirect('/panel');
}

export async function cerrarSesion(): Promise<void> {
  const supabase = await getSupabaseServer();
  await supabase.auth.signOut();
  redirect('/entrar');
}
