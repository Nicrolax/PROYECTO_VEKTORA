/**
 * VEKTORA — Carga de `.env.local` para procesos que NO son Next.js.
 *
 * Next.js carga `.env.local` por su cuenta, pero `tsx scripts/…` no. Importar este módulo
 * como PRIMERA línea de un script deja el entorno equivalente al de la app, sin duplicar
 * la lógica de dotenv en cada archivo.
 *
 * Precedencia (gana lo primero que define cada variable):
 *   1. lo que ya hubiera en `process.env` (CI, shell)
 *   2. .env.local
 *   3. .env
 *
 * Nunca imprime valores.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import * as dotenv from 'dotenv';

const CANDIDATES = ['.env.local', '.env'] as const;

let loadedFiles: string[] | null = null;

/** Carga los archivos de entorno una sola vez. Devuelve los que existían. */
export function loadEnv(cwd: string = process.cwd()): string[] {
  if (loadedFiles !== null) return loadedFiles;

  const loaded: string[] = [];
  for (const candidate of CANDIDATES) {
    const path = resolve(cwd, candidate);
    if (!existsSync(path)) continue;
    // `override: false`: lo que ya está en el entorno manda sobre el archivo.
    dotenv.config({ path, override: false, quiet: true });
    loaded.push(candidate);
  }
  loadedFiles = loaded;
  return loaded;
}

/** Variable obligatoria. Lanza con un mensaje accionable en vez de devolver undefined. */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(
      `VEKTORA: falta la variable de entorno ${name}. Cópiala de env.example a .env.local.`,
    );
  }
  return value.trim();
}

/** Variable opcional, normalizada a `undefined` cuando está vacía. */
export function optionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

// Efecto al importar: es justo lo que se quiere en la primera línea de un script.
loadEnv();
