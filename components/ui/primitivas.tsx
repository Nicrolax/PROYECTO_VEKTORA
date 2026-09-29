import Link from 'next/link';
import type { Route } from 'next';
import { presentarTarea, presentarQa } from '@/components/estados';

/** Etiqueta de estado. El punto de color es el mismo dato que colorea el grafo. */
export function Insignia({ estado, tipo = 'tarea' }: { estado: string; tipo?: 'tarea' | 'qa' }) {
  const { etiqueta, color, ayuda } = tipo === 'qa' ? presentarQa(estado) : presentarTarea(estado);
  return (
    <span
      title={ayuda}
      className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium whitespace-nowrap"
      style={{
        borderColor: `color-mix(in oklch, ${color} 35%, transparent)`,
        backgroundColor: `color-mix(in oklch, ${color} 10%, transparent)`,
        color,
      }}
    >
      <span aria-hidden className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: color }} />
      {etiqueta}
    </span>
  );
}

export function Panel({
  children,
  className = '',
  vivo = false,
  retraso = 0,
}: {
  children: React.ReactNode;
  className?: string;
  vivo?: boolean;
  retraso?: number;
}) {
  return (
    <section
      className={`tarjeta entra ${vivo ? 'tarjeta-viva' : ''} ${className}`}
      style={retraso > 0 ? { animationDelay: `${retraso}ms` } : undefined}
    >
      {children}
    </section>
  );
}

export function Titulo({ children, ayuda }: { children: React.ReactNode; ayuda?: string }) {
  return (
    <div className="space-y-1">
      <h2 className="text-sm font-semibold">{children}</h2>
      {ayuda !== undefined && (
        <p className="text-xs leading-relaxed text-[var(--color-apagado)]">{ayuda}</p>
      )}
    </div>
  );
}

export function Dato({ etiqueta, valor }: { etiqueta: string; valor: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <dt className="text-[0.7rem] tracking-wide text-[var(--color-apagado)] uppercase">
        {etiqueta}
      </dt>
      <dd className="text-sm tabular-nums">{valor}</dd>
    </div>
  );
}

export function Vacio({ children, accion }: { children: React.ReactNode; accion?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-4 rounded-2xl border border-dashed border-[var(--color-borde)] px-6 py-12 text-center">
      <p className="max-w-sm text-sm leading-relaxed text-balance text-[var(--color-apagado)]">
        {children}
      </p>
      {accion}
    </div>
  );
}

export function EnlaceBoton({
  href,
  children,
  variante = 'suave',
}: {
  href: Route;
  children: React.ReactNode;
  variante?: 'primario' | 'suave';
}) {
  const clases =
    variante === 'primario'
      ? 'boton boton-primario degradado-marca'
      : 'boton boton-suave';
  return (
    <Link href={href} className={clases}>
      {children}
    </Link>
  );
}

/** Dinero con el formato de Uruguay y el símbolo de la moneda del proyecto. */
export function Dinero({ valor, moneda = 'USD' }: { valor: number | null; moneda?: string }) {
  if (valor === null) return <span className="text-[var(--color-apagado)]">—</span>;
  return (
    <span className="tabular-nums">
      {new Intl.NumberFormat('es-UY', {
        style: 'currency',
        currency: moneda,
        maximumFractionDigits: 2,
      }).format(valor)}
    </span>
  );
}

/** Barra de avance. `aria-valuenow` es lo que la hace legible para un lector de pantalla. */
export function Avance({ porcentaje, etiqueta }: { porcentaje: number; etiqueta: string }) {
  return (
    <div
      className="h-1.5 overflow-hidden rounded-full bg-[var(--color-lienzo-alto)]"
      role="progressbar"
      aria-valuenow={porcentaje}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={etiqueta}
    >
      <div
        className="h-full rounded-full transition-[width] duration-700"
        style={{
          width: `${porcentaje}%`,
          background:
            porcentaje === 100
              ? 'var(--color-aprobada)'
              : 'linear-gradient(90deg, var(--color-acento), var(--color-acento-fin))',
        }}
      />
    </div>
  );
}
