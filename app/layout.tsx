import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'VEKTORA', template: '%s · VEKTORA' },
  description:
    'Planteás un objetivo. El sistema lo descompone en tareas, las adjudica, evalúa lo ' +
    'entregado y avanza. Sin que nadie apruebe nada por el camino.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#16131f',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body className="min-h-dvh antialiased">{children}</body>
    </html>
  );
}
