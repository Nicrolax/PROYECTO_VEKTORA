/**
 * VEKTORA · FASE 6 — Disparador local de los trabajos programados.
 *
 *   npm run cron              # emparejar y luego evaluar
 *   npm run cron -- emparejar
 *   npm run cron -- evaluar
 *   npm run cron -- --url http://localhost:3001
 *
 * En producción estos trabajos los dispara el planificador de Vercel cada pocos minutos.
 * En desarrollo NO existe ese reloj: `next dev` sirve páginas y nada más. Sin este script,
 * una tarea recién planificada se queda esperando a alguien que nunca llega, y el sistema
 * parece roto cuando en realidad está funcionando y no tiene quién le dé cuerda.
 *
 * Llama a los endpoints HTTP reales con el mismo secreto que usará Vercel, así que lo que
 * se prueba aquí es exactamente lo que va a correr desplegado — incluida la autorización.
 */

import '@/lib/env';

import { errorMessage } from '@/lib/ai/errors';

type Trabajo = 'emparejar' | 'evaluar';

const RUTA: Record<Trabajo, string> = {
  emparejar: '/api/cron/emparejar',
  evaluar: '/api/cron/evaluar',
};

function line(label: string, value: string): void {
  console.log(`  ${label.padEnd(22)} ${value}`);
}

async function disparar(trabajo: Trabajo, base: string, secreto: string): Promise<boolean> {
  const url = `${base}${RUTA[trabajo]}`;
  console.log(`\n▸ ${trabajo}  ${url}`);

  let respuesta: Response;
  try {
    respuesta = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${secreto}` },
    });
  } catch (error) {
    console.error(
      `  ✗ no se pudo conectar -> ${errorMessage(error)}\n` +
        '    ¿Está corriendo `npm run dev`? Si usa otro puerto, pasá --url http://localhost:<puerto>',
    );
    return false;
  }

  const texto = await respuesta.text();
  let cuerpo: unknown = null;
  try {
    cuerpo = JSON.parse(texto) as unknown;
  } catch {
    cuerpo = null;
  }

  if (!respuesta.ok) {
    const detalle =
      typeof cuerpo === 'object' && cuerpo !== null && 'error' in cuerpo
        ? String((cuerpo as { error: unknown }).error)
        : texto.slice(0, 300);
    console.error(`  ✗ ${respuesta.status} -> ${detalle}`);
    if (respuesta.status === 401) {
      console.error('    El CRON_SECRET del script no coincide con el del servidor.');
      console.error('    Si acabás de añadirlo a .env.local, reiniciá `npm run dev`.');
    }
    return false;
  }

  const datos = (cuerpo ?? {}) as Record<string, unknown>;

  if (trabajo === 'emparejar') {
    line('tareas revisadas:', String(datos['revisadas'] ?? 0));
    line('adjudicadas:', String(datos['adjudicadas'] ?? 0));
    for (const fila of (datos['detalle'] as Array<Record<string, unknown>>) ?? []) {
      const estado =
        fila['error'] !== undefined
          ? `error: ${String(fila['error'])}`
          : fila['adjudicada'] === true
            ? fila['escalada'] === true
              ? 'ADJUDICADA (por agotamiento de rondas)'
              : 'ADJUDICADA'
            : `sin adjudicar — ${String(fila['motivo'] ?? 'sin candidatos')}`;
      const proyecto = fila['proyecto'];
      const donde = typeof proyecto === 'string' ? `  [${proyecto.slice(0, 32)}]` : '';
      console.log(`     · ${String(fila['code'] ?? '?').padEnd(6)}${donde} ${estado}`);
    }
  } else {
    line('entregables vistos:', String(datos['evaluados'] ?? 0));
    line('con veredicto:', String(datos['conVeredicto'] ?? 0));
    for (const fila of (datos['detalle'] as Array<Record<string, unknown>>) ?? []) {
      const veredicto = fila['veredicto'];
      const estado =
        veredicto === null || veredicto === undefined
          ? `sin veredicto — ${String(fila['motivo'] ?? '?')}`
          : `${String(veredicto)} (${String(fila['puntuacion'] ?? '?')})`;
      console.log(`     · ${String(fila['tarea'] ?? '?').padEnd(6)} ${estado}`);
    }
  }

  return true;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((arg) => arg !== '***');

  const indiceUrl = args.indexOf('--url');
  const base = (indiceUrl === -1 ? undefined : args[indiceUrl + 1]) ?? 'http://localhost:3000';

  const pedidos = args.filter((arg): arg is Trabajo => arg === 'emparejar' || arg === 'evaluar');
  const trabajos: Trabajo[] = pedidos.length > 0 ? pedidos : ['emparejar', 'evaluar'];

  const secreto = process.env['CRON_SECRET']?.trim();
  if (secreto === undefined || secreto === '') {
    console.error(
      '\nFalta CRON_SECRET en .env.local.\n' +
        'Generalo con:  openssl rand -hex 32\n' +
        'y reiniciá `npm run dev` después de añadirlo.\n',
    );
    process.exitCode = 1;
    return;
  }

  console.log('\n=== VEKTORA · disparador local de trabajos programados ===');
  console.log(
    '\nEn producción esto lo hace el reloj de Vercel. En desarrollo hay que darle cuerda.',
  );

  let todoBien = true;
  for (const trabajo of trabajos) {
    const ok = await disparar(trabajo, base.replace(/\/$/, ''), secreto);
    todoBien = todoBien && ok;
  }

  console.log('\n=== Fin ===\n');
  if (!todoBien) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(`\nVEKTORA/CRON: falló -> ${errorMessage(error)}\n`);
  process.exitCode = 1;
});
