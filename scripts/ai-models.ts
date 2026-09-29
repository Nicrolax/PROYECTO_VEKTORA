/**
 * VEKTORA — Qué modelos tienen disponibles TUS claves.
 *
 *   npm run ai:models
 *
 * Pregunta a cada proveedor por su catálogo real en vez de confiar en la documentación:
 * los modelos se retiran, y lo que está publicado, lo que ve una cuenta nueva y lo que ve
 * un free tier no siempre coinciden. La única fuente de verdad es el listado que devuelve
 * la API con tu clave.
 *
 * Marca con -> el modelo configurado hoy en `.env.local`, y avisa si ya no está.
 * No imprime ninguna clave.
 */

import '@/lib/env';

import { aiConfigWarnings, getAiConfig } from '@/lib/ai/config';
import { errorMessage } from '@/lib/ai/errors';

interface ModelInfo {
  id: string;
  detail?: string;
}

async function listGroqModels(apiKey: string, baseUrl: string): Promise<ModelInfo[]> {
  const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/models`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${(await response.text()).slice(0, 200)}`);
  }
  const payload = (await response.json()) as {
    data?: Array<{ id?: string; owned_by?: string; context_window?: number; active?: boolean }>;
  };
  return (payload.data ?? [])
    .filter((entry) => typeof entry.id === 'string')
    .map((entry) => ({
      id: entry.id as string,
      detail: [
        entry.owned_by,
        entry.context_window === undefined ? undefined : `ctx ${entry.context_window}`,
        entry.active === false ? 'INACTIVO' : undefined,
      ]
        .filter((part) => part !== undefined)
        .join(' · '),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

async function listGoogleModels(apiKey: string, baseUrl: string): Promise<ModelInfo[]> {
  const models: ModelInfo[] = [];
  let pageToken: string | undefined;

  // El listado de Google viene paginado: sin recorrerlo entero se pierden modelos.
  do {
    const url = new URL(`${baseUrl.replace(/\/+$/, '')}/models`);
    url.searchParams.set('pageSize', '200');
    if (pageToken !== undefined) url.searchParams.set('pageToken', pageToken);

    const response = await fetch(url, { headers: { 'x-goog-api-key': apiKey } });
    if (!response.ok) {
      throw new Error(`${response.status} ${(await response.text()).slice(0, 200)}`);
    }
    const payload = (await response.json()) as {
      models?: Array<{ name?: string; supportedGenerationMethods?: string[] }>;
      nextPageToken?: string;
    };
    for (const entry of payload.models ?? []) {
      if (typeof entry.name !== 'string') continue;
      models.push({
        id: entry.name.replace(/^models\//, ''),
        detail: (entry.supportedGenerationMethods ?? []).join(', '),
      });
    }
    pageToken = payload.nextPageToken;
  } while (pageToken !== undefined);

  return models.sort((a, b) => a.id.localeCompare(b.id));
}

function print(title: string, models: readonly ModelInfo[], configured: string): void {
  console.log(`\n${title}`);
  console.log('─'.repeat(title.length));

  if (models.length === 0) {
    console.log('  (ninguno)');
    return;
  }
  for (const model of models) {
    const marker = model.id === configured ? '->' : '  ';
    console.log(`  ${marker} ${model.id.padEnd(42)} ${model.detail ?? ''}`);
  }

  const present = models.some((model) => model.id === configured);
  console.log(
    present
      ? `\n  El modelo configurado (${configured}) está disponible.`
      : `\n  ✗ EL MODELO CONFIGURADO NO ESTÁ EN LA LISTA: ${configured}\n` +
          '    Actualízalo en .env.local o las llamadas fallarán con 404.',
  );
}

async function main(): Promise<void> {
  console.log('\n══════════════════════════════════════════════════════');
  console.log(' VEKTORA · modelos disponibles para tus claves');
  console.log('══════════════════════════════════════════════════════');

  const config = getAiConfig();
  for (const warning of aiConfigWarnings(config)) console.log(`  · aviso: ${warning}`);

  let failures = 0;

  if (config.GROQ_API_KEY) {
    try {
      const models = await listGroqModels(config.GROQ_API_KEY, config.GROQ_BASE_URL);
      print('GROQ · generación', models, config.GROQ_MODEL);
    } catch (error) {
      failures += 1;
      console.log(`\nGROQ: no se pudo listar -> ${errorMessage(error)}`);
    }
  } else {
    console.log('\nGROQ: sin clave configurada.');
  }

  if (config.GOOGLE_AI_API_KEY) {
    try {
      const models = await listGoogleModels(config.GOOGLE_AI_API_KEY, config.GOOGLE_AI_BASE_URL);
      const generation = models.filter((model) =>
        (model.detail ?? '').includes('generateContent'),
      );
      const embedding = models.filter((model) => (model.detail ?? '').includes('embedContent'));

      print('GOOGLE AI STUDIO · generación', generation, config.GOOGLE_AI_MODEL);
      print('GOOGLE AI STUDIO · embeddings', embedding, config.AI_EMBEDDING_MODEL);
    } catch (error) {
      failures += 1;
      console.log(`\nGOOGLE: no se pudo listar -> ${errorMessage(error)}`);
    }
  } else {
    console.log('\nGOOGLE: sin clave configurada.');
  }

  console.log('\n──────────────────────────────────────────────────────');
  console.log(' Para cambiarlos, en .env.local:');
  console.log('   GROQ_MODEL=<id>');
  console.log('   GOOGLE_AI_MODEL=<id>');
  console.log('   AI_EMBEDDING_MODEL=<id>   (ojo: cambiar esto invalida los embeddings');
  console.log('                              ya guardados; habría que revectorizar)');
  console.log('══════════════════════════════════════════════════════\n');

  if (failures > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(`\nVEKTORA/AI: no se pudieron listar los modelos -> ${errorMessage(error)}\n`);
  process.exitCode = 1;
});
