'use client';

import Link from 'next/link';
import type { Route } from 'next';
import { usePathname } from 'next/navigation';

/**
 * Navegación con indicador de sección activa.
 *
 * El subrayado se dibuja con un pseudo-elemento animado en vez de cambiar el borde: así la
 * transición entre secciones es un deslizamiento y no un parpadeo, que es la diferencia
 * entre que la interfaz se sienta rápida o se sienta brusca.
 */
const SECCIONES: { href: Route; etiqueta: string }[] = [
  { href: '/panel', etiqueta: 'Mis proyectos' },
  { href: '/proveedor', etiqueta: 'Mi trabajo' },
];

export function Navegacion() {
  const ruta = usePathname();

  return (
    <nav aria-label="Principal" className="flex items-center gap-0.5">
      {SECCIONES.map((seccion) => {
        const activa = ruta === seccion.href || ruta.startsWith(`${seccion.href}/`);
        return (
          <Link
            key={seccion.href}
            href={seccion.href}
            aria-current={activa ? 'page' : undefined}
            className="relative rounded-lg px-3 py-1.5 text-sm transition-colors duration-200"
            style={{ color: activa ? 'var(--color-texto)' : 'var(--color-apagado)' }}
          >
            {seccion.etiqueta}
            <span
              aria-hidden
              className="degradado-marca absolute inset-x-3 -bottom-[13px] h-[2px] rounded-full transition-all duration-300"
              style={{
                opacity: activa ? 1 : 0,
                transform: activa ? 'scaleX(1)' : 'scaleX(0.3)',
              }}
            />
          </Link>
        );
      })}
    </nav>
  );
}
