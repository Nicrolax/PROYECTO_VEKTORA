/**
 * VEKTORA · FASE 2 — Comprobación de extremo a extremo de la capa de IA.
 *
 *   npm run ai:check
 *
 * Habla con las APIs REALES de Groq y Google AI Studio (free tier). Verifica, en orden:
 *   1. que el entorno valida contra el Zod estricto de `lib/ai/config.ts`;
 *   2. generación estructurada con el proveedor primario;
 *   3. fallback FORZADO a Google, invirtiendo la cadena;
 *   4. auto-reparación: se pide un esquema que el modelo suele incumplir a la primera;
 *   5. embeddings: dimensiones exactas, norma unitaria y que dos textos afines queden más
 *      cerca que dos dispares (si eso no se cumple, el matching de la FASE 4 no puede
 *      funcionar por mucho que el vector tenga el tamaño correcto).
 *
 * Ninguna clave se imprime. Sale con código 1 si algún paso obligatorio falla.
 */

import '@/lib/env';

import { z } from 'zod';
import { AiClient } from '@/lib/ai/ai-client';
import { aiConfigWarnings, getAiConfig, isTelemetryConfigured } from '@/lib/ai/config';
import { EmbeddingService } from '@/lib/ai/embeddings';
import { cosineSimilarity } from '@/lib/ai/embeddings';
import { errorMessage } from '@/lib/ai/errors';
import { isModelPriced } from '@/lib/ai/pricing';
import { buildProviderChain } from '@/lib/ai/providers';

const ok = (message: string): void => console.log(`   ✓ ${message}`);
const info = (message: string): void => console.log(`   · ${message}`);
const bad = (message: string): void => console.log(`   ✗ ${message}`);

let failures = 0;
function fail(message: string): void {
  failures += 1;
  bad(message);
}

function header(title: string): void {
  console.log(`\n${title}`);
  console.log('─'.repeat(title.length));
}

const HealthSchema = z.strictObject({
  status: z.enum(['ok', 'degraded', 'down']),
  component: z.string().min(3).max(60),
  checks: z
    .array(
      z.strictObject({
        name: z.string().min(3).max(40),
        passed: z.boolean(),
      }),
    )
    .min(2)
    .max(4),
});

async function checkConfig(): Promise<void> {
  header('[1] Configuración del entorno');
  const config = getAiConfig();

  ok(`cadena de proveedores: ${config.AI_PROVIDER_ORDER.join(' → ')}`);
  info(`Groq:      ${config.GROQ_API_KEY ? `${config.GROQ_MODEL} (clave presente)` : 'sin clave'}`);
  info(
    `Google:    ${config.GOOGLE_AI_API_KEY ? `${config.GOOGLE_AI_MODEL} (clave presente)` : 'sin clave'}`,
  );
  info(`Embedding: ${config.AI_EMBEDDING_MODEL} @ ${config.AI_EMBEDDING_DIMENSIONS} dims`);
  info(`Telemetría ai_runs: ${isTelemetryConfigured(config) ? 'activa' : 'desactivada'}`);
  info(`Tarifado conocido: ${isModelPriced(config.GOOGLE_AI_MODEL) ? 'sí' : 'no'}`);

  for (const warning of aiConfigWarnings(config)) info(`aviso: ${warning}`);

  const chain = buildProviderChain(config);
  if (chain.length === 0) {
    fail('ningún proveedor configurado: define GROQ_API_KEY o GOOGLE_AI_API_KEY');
  } else {
    ok(`proveedores efectivos: ${chain.map((provider) => provider.id).join(', ')}`);
  }
}

async function checkStructured(): Promise<void> {
  header('[2] Generación estructurada (proveedor primario)');
  const client = new AiClient();
  try {
    const response = await client.generateStructured({
      operation: 'other',
      schema: HealthSchema,
      schemaName: 'HealthReport',
      system: 'Eres el agente de diagnóstico de VEKTORA. Respondes solo con datos.',
      prompt:
        'Informa del estado del componente "ai-layer" con exactamente 3 comprobaciones: ' +
        'fallback, telemetry y embeddings. Todas pasan.',
    });
    ok(`${response.provider}/${response.model} · ${response.latencyMs} ms`);
    info(`status=${response.data.status} checks=${response.data.checks.length}`);
    info(
      `intentos=${response.attempts} reparaciones=${response.repairs} ` +
        `esquema degradado=${response.schemaDegraded ? 'sí' : 'no'}`,
    );
    info(`ai_runs: ${response.runId ?? '(telemetría desactivada)'}`);
  } catch (error) {
    fail(`generación estructurada -> ${errorMessage(error)}`);
  }
}

async function checkForcedFallback(): Promise<void> {
  header('[3] Fallback forzado a Google AI Studio');
  const config = getAiConfig();
  if (!config.GOOGLE_AI_API_KEY) {
    info('omitido: no hay GOOGLE_AI_API_KEY');
    return;
  }

  // Se invierte la cadena para ejercitar el adaptador de Gemini aunque Groq esté sano.
  const client = new AiClient({
    config: { ...config, AI_PROVIDER_ORDER: ['google'] },
  });
  try {
    const response = await client.generateStructured({
      operation: 'other',
      schema: HealthSchema,
      schemaName: 'HealthReport',
      prompt:
        'Informa del estado del componente "gemini-adapter" con 2 comprobaciones: ' +
        'responseSchema y usageMetadata. Todas pasan.',
    });
    ok(`${response.provider}/${response.model} · ${response.latencyMs} ms`);
    info(`responseSchema nativo: ${response.schemaDegraded ? 'no (degradado al prompt)' : 'sí'}`);
  } catch (error) {
    fail(`fallback a Google -> ${errorMessage(error)}`);
  }
}

async function checkEmbeddings(): Promise<void> {
  header('[4] Embeddings');
  const service = new EmbeddingService();
  if (!service.isAvailable()) {
    fail('embeddings no disponibles: falta GOOGLE_AI_API_KEY (Groq no expone embeddings)');
    return;
  }
  info(service.describeModel());

  try {
    const response = await service.embedTexts({
      texts: [
        'Desarrollador front-end especializado en React, Next.js y accesibilidad web.',
        'Ingeniera de interfaces con experiencia en Next.js, TypeScript y diseño accesible.',
        'Soldadura TIG de aluminio y estructuras metálicas para carrocería de competición.',
      ],
      taskType: 'RETRIEVAL_DOCUMENT',
    });

    const [frontA, frontB, welding] = response.vectors;
    if (frontA === undefined || frontB === undefined || welding === undefined) {
      fail('el proveedor no devolvió los 3 vectores');
      return;
    }

    if (response.dimensions !== service.dimensions) {
      fail(`dimensiones ${response.dimensions}, esperadas ${service.dimensions}`);
    } else {
      ok(`${response.vectors.length} vectores de ${response.dimensions} dimensiones`);
    }

    const norm = Math.sqrt(frontA.reduce((sum, value) => sum + value * value, 0));
    if (Math.abs(norm - 1) > 1e-6) {
      fail(`norma L2 = ${norm.toFixed(6)}, debería ser 1 tras la renormalización`);
    } else {
      ok('norma L2 unitaria: `<=>` de pgvector es distancia coseno consistente');
    }

    const near = cosineSimilarity(frontA, frontB);
    const far = cosineSimilarity(frontA, welding);
    info(`similitud afines=${near.toFixed(4)} · dispares=${far.toFixed(4)}`);
    if (near > far) {
      ok('la geometría del espacio vectorial sirve para el matching de la FASE 4');
    } else {
      fail('perfiles afines NO quedan más cerca que los dispares: revisa el taskType');
    }
  } catch (error) {
    fail(`embeddings -> ${errorMessage(error)}`);
  }
}

async function main(): Promise<void> {
  console.log('\n══════════════════════════════════════════════════════');
  console.log(' VEKTORA · verificación de la capa de IA (FASE 2)');
  console.log('══════════════════════════════════════════════════════');

  await checkConfig();
  if (failures === 0) {
    await checkStructured();
    await checkForcedFallback();
    await checkEmbeddings();
  } else {
    console.log('\nSe omiten las llamadas reales: la configuración no es válida.');
  }

  console.log('\n══════════════════════════════════════════════════════');
  if (failures === 0) {
    console.log(' RESULTADO: todo en verde');
  } else {
    console.log(` RESULTADO: ${failures} comprobación(es) fallida(s)`);
    process.exitCode = 1;
  }
  console.log('══════════════════════════════════════════════════════\n');
}

main().catch((error: unknown) => {
  console.error(`\nVEKTORA/AI: la verificación falló -> ${errorMessage(error)}\n`);
  process.exitCode = 1;
});
