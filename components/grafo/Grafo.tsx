'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { presentarTarea } from '@/components/estados';
import {
  ALTO_NODO,
  ANCHO_NODO,
  disponerGrafo,
  type TareaGrafo,
} from '@/components/grafo/disposicion';

/**
 * Visualizador interactivo del grafo (RF-8.1, RF-8.2).
 *
 * SVG propio en lugar de una librería de grafos. El motivo no es evitar una dependencia por
 * deporte: la disposición ya la resuelve el álgebra de grafos de la FASE 3, que es la misma
 * que usó el planificador para ordenar las tareas. Una librería genérica recalcularía otra
 * disposición distinta y el dibujo dejaría de corresponderse con el orden real de ejecución.
 *
 * Interacción: clic o Enter selecciona una tarea, las flechas recorren el grafo, se puede
 * arrastrar para desplazarse y hay zoom. Todo es alcanzable por teclado (RNF-3.6).
 */
export function Grafo({
  tareas,
  seleccionada,
  onSeleccionar,
}: {
  tareas: readonly TareaGrafo[];
  seleccionada: string | null;
  onSeleccionar: (id: string) => void;
}) {
  const router = useRouter();
  const disposicion = useMemo(() => disponerGrafo(tareas), [tareas]);
  const [escala, setEscala] = useState(1);
  const [desplazamiento, setDesplazamiento] = useState({ x: 0, y: 0 });
  const arrastre = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);

  const alSoltar = useCallback(() => {
    arrastre.current = null;
  }, []);

  const alMover = useCallback((evento: React.PointerEvent) => {
    const inicio = arrastre.current;
    if (inicio === null) return;
    setDesplazamiento({
      x: inicio.ox + (evento.clientX - inicio.x),
      y: inicio.oy + (evento.clientY - inicio.y),
    });
  }, []);

  if (disposicion.nodos.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-[var(--color-borde)] px-4 py-10 text-center text-sm text-[var(--color-apagado)]">
        Este proyecto todavía no tiene tareas.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-[var(--color-apagado)]">
          {disposicion.nodos.length} tareas en {disposicion.niveles}{' '}
          {disposicion.niveles === 1 ? 'nivel' : 'niveles'} de ejecución. La columna de cada
          tarea es su profundidad en el grafo.
        </p>
        <div className="flex items-center gap-1">
          <BotonZoom etiqueta="Alejar" onClick={() => setEscala((e) => Math.max(0.4, e - 0.15))}>
            −
          </BotonZoom>
          <BotonZoom
            etiqueta="Restablecer vista"
            onClick={() => {
              setEscala(1);
              setDesplazamiento({ x: 0, y: 0 });
            }}
          >
            ⟳
          </BotonZoom>
          <BotonZoom etiqueta="Acercar" onClick={() => setEscala((e) => Math.min(2, e + 0.15))}>
            +
          </BotonZoom>
        </div>
      </div>

      <div
        className="overflow-hidden rounded-2xl border border-[var(--color-borde)] bg-[var(--color-lienzo-alto)]/60"
        onPointerMove={alMover}
        onPointerUp={alSoltar}
        onPointerLeave={alSoltar}
      >
        <svg
          role="img"
          aria-label={`Grafo de ${disposicion.nodos.length} tareas`}
          viewBox={`0 0 ${disposicion.ancho} ${disposicion.alto}`}
          className="w-full cursor-grab touch-pan-y active:cursor-grabbing"
          style={{ height: `min(68vh, ${disposicion.alto}px)` }}
          onPointerDown={(evento) => {
            arrastre.current = {
              x: evento.clientX,
              y: evento.clientY,
              ox: desplazamiento.x,
              oy: desplazamiento.y,
            };
          }}
        >
          <defs>
            <marker
              id="punta"
              viewBox="0 0 8 8"
              refX="7"
              refY="4"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 8 4 L 0 8 z" fill="var(--color-borde)" />
            </marker>
            <marker
              id="punta-viva"
              viewBox="0 0 8 8"
              refX="7"
              refY="4"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 8 4 L 0 8 z" fill="var(--color-aprobada)" />
            </marker>
          </defs>

          <g
            transform={`translate(${desplazamiento.x} ${desplazamiento.y}) scale(${escala})`}
            style={{ transition: arrastre.current === null ? 'transform 120ms ease-out' : 'none' }}
          >
            {disposicion.aristas.map((arista) => (
              <path
                key={`${arista.desde}->${arista.hasta}`}
                d={arista.trazo}
                fill="none"
                stroke={arista.satisfecha ? 'var(--color-aprobada)' : 'var(--color-borde)'}
                strokeWidth={arista.satisfecha ? 1.8 : 1.2}
                strokeDasharray={arista.satisfecha ? undefined : '4 4'}
                markerEnd={arista.satisfecha ? 'url(#punta-viva)' : 'url(#punta)'}
                opacity={arista.satisfecha ? 0.85 : 0.5}
              />
            ))}

            {disposicion.nodos.map((nodo, indice) => {
              const { color, etiqueta, ayuda } = presentarTarea(nodo.status);
              const activa = nodo.id === seleccionada;
              return (
                <g
                  key={nodo.id}
                  transform={`translate(${nodo.x} ${nodo.y})`}
                  tabIndex={0}
                  role="button"
                  aria-label={`${nodo.code}: ${nodo.title}. Estado: ${etiqueta}`}
                  aria-pressed={activa}
                  className="cursor-pointer outline-none"
                  onClick={() => onSeleccionar(nodo.id)}
                  onKeyDown={(evento) => {
                    if (evento.key === 'Enter' || evento.key === ' ') {
                      evento.preventDefault();
                      onSeleccionar(nodo.id);
                    }
                    if (evento.key === 'ArrowRight' || evento.key === 'ArrowDown') {
                      evento.preventDefault();
                      const siguiente = disposicion.nodos[indice + 1];
                      if (siguiente !== undefined) onSeleccionar(siguiente.id);
                    }
                    if (evento.key === 'ArrowLeft' || evento.key === 'ArrowUp') {
                      evento.preventDefault();
                      const anterior = disposicion.nodos[indice - 1];
                      if (anterior !== undefined) onSeleccionar(anterior.id);
                    }
                    if (evento.key === 'o') router.push(`/tareas/${nodo.id}`);
                  }}
                >
                  <title>{`${nodo.code} · ${etiqueta} — ${ayuda}`}</title>
                  <rect
                    width={ANCHO_NODO}
                    height={ALTO_NODO}
                    rx={12}
                    fill={activa ? 'var(--color-panel-alto)' : 'var(--color-panel)'}
                    stroke={activa ? color : 'var(--color-borde)'}
                    strokeWidth={activa ? 1.8 : 1}
                    style={{ transition: 'fill 200ms var(--ease-suave), stroke 200ms var(--ease-suave)' }}
                  />
                  <rect x={0} y={10} width={3} height={ALTO_NODO - 20} rx={2} fill={color} />
                  <text x={16} y={24} className="fill-[var(--color-apagado)] text-[11px] font-mono">
                    {nodo.code}
                  </text>
                  <text x={16} y={44} className="fill-[var(--color-texto)] text-[13px]">
                    {nodo.title.length > 27 ? `${nodo.title.slice(0, 26)}…` : nodo.title}
                  </text>
                  <text x={16} y={58} className="text-[10px]" fill={color}>
                    {etiqueta}
                  </text>
                </g>
              );
            })}
          </g>
        </svg>
      </div>

      <p className="text-xs text-[var(--color-apagado)]">
        Clic para ver el detalle · flechas para recorrer · <kbd>o</kbd> para abrir la tarea ·
        arrastrar para desplazar
      </p>
    </div>
  );
}

function BotonZoom({
  children,
  etiqueta,
  onClick,
}: {
  children: React.ReactNode;
  etiqueta: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={etiqueta}
      title={etiqueta}
      className="h-8 w-8 rounded-lg border border-[var(--color-borde)] text-sm text-[var(--color-tenue)] transition-colors hover:border-[var(--color-borde-vivo)] hover:bg-[var(--color-panel)] hover:text-[var(--color-texto)]"
    >
      {children}
    </button>
  );
}
