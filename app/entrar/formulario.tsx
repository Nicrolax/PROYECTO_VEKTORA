'use client';

import { useFormStatus } from 'react-dom';
import { iniciarSesion, registrarse } from './acciones';

/**
 * Un solo formulario con dos botones que apuntan a acciones distintas mediante
 * `formAction`. Anidar dos formularios sería HTML inválido y el navegador descartaría el
 * interno sin avisar.
 */
function Boton({
  children,
  accion,
  variante,
}: {
  children: React.ReactNode;
  accion: (formData: FormData) => Promise<void>;
  variante: 'primario' | 'suave';
}) {
  const { pending } = useFormStatus();
  const clases =
    variante === 'primario'
      ? 'boton boton-primario degradado-marca w-full'
      : 'boton boton-suave w-full';

  return (
    <button type="submit" formAction={accion} disabled={pending} className={clases}>
      {pending ? 'Un momento…' : children}
    </button>
  );
}

export function FormularioAcceso() {
  return (
    <form className="space-y-4">
      <div className="space-y-1.5">
        <label htmlFor="email" className="block text-sm font-medium text-[var(--color-tenue)]">
          Correo
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          placeholder="tu@correo.com"
          className="campo"
        />
      </div>

      <div className="space-y-1.5">
        <label htmlFor="password" className="block text-sm font-medium text-[var(--color-tenue)]">
          Contraseña
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          minLength={8}
          className="campo"
        />
        <p className="text-xs text-[var(--color-apagado)]">Mínimo 8 caracteres.</p>
      </div>

      <div className="space-y-2.5 pt-2">
        <Boton accion={iniciarSesion} variante="primario">
          Entrar
        </Boton>
        <Boton accion={registrarse} variante="suave">
          Crear cuenta
        </Boton>
      </div>
    </form>
  );
}
