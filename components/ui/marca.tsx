/**
 * Marca y fondos compartidos.
 *
 * El isotipo es un vector que apunta hacia adelante: es lo que el nombre significa y lo que
 * hace el sistema —empujar un proyecto hasta el final sin que nadie lo arrastre—. Se dibuja
 * en SVG y no como imagen para que herede el degradado y escale sin pesar nada.
 */
export function Isotipo({ tamano = 22 }: { tamano?: number }) {
  return (
    <svg
      width={tamano}
      height={tamano}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
      className="shrink-0"
    >
      <defs>
        <linearGradient id="marca" x1="0" y1="0" x2="24" y2="24" gradientUnits="userSpaceOnUse">
          <stop stopColor="var(--color-acento)" />
          <stop offset="0.5" stopColor="var(--color-acento-claro)" />
          <stop offset="1" stopColor="var(--color-acento-fin)" />
        </linearGradient>
      </defs>
      <path d="M3 3.2 L21 12 L3 20.8 L7.4 12 Z" fill="url(#marca)" />
    </svg>
  );
}

export function Logotipo({ tamano = 22 }: { tamano?: number }) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <Isotipo tamano={tamano} />
      <span className="text-[0.95rem] font-semibold tracking-[-0.03em]">VEKTORA</span>
    </span>
  );
}

/**
 * Halos de color desenfocados detrás del contenido. Dan profundidad sin una sola imagen:
 * nada que descargar, nada que optimizar, y escalan a cualquier pantalla.
 */
export function Fondo({ intensidad = 'suave' }: { intensidad?: 'suave' | 'fuerte' }) {
  // Discreto a propósito. Un halo que se nota es un fondo que compite con el contenido;
  // el trabajo del color aquí es dar profundidad, no llamar la atención.
  const opacidad = intensidad === 'fuerte' ? 0.28 : 0.13;
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
      <div
        className="halo"
        style={{
          width: '46rem',
          height: '46rem',
          top: '-18rem',
          left: '-12rem',
          background: 'var(--color-acento)',
          opacity: opacidad,
        }}
      />
      <div
        className="halo"
        style={{
          width: '38rem',
          height: '38rem',
          bottom: '-16rem',
          right: '-10rem',
          background: 'var(--color-acento-fin)',
          opacity: opacidad * 0.8,
          animationDelay: '-7s',
        }}
      />
    </div>
  );
}
