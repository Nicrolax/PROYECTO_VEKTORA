/**
 * VEKTORA · FASE 2 — Adaptador de generación de Google AI Studio (proveedor de fallback).
 * Los embeddings viven en `gemini-embeddings.ts`: es otro modelo y otro endpoint.
 *
 * `POST {base}/models/{model}:generateContent?key=...`
 *
 * Salida estructurada: `responseMimeType: 'application/json'` + `responseSchema`. Si la
 * traducción del JSON Schema al `Schema` de Google no es posible, o si la API responde 400
 * señalando el esquema, se degrada a esquema-en-el-prompt y se marca `schemaDegraded`.
 */

import type { AiConfig } from '../config';
import { AiError, isAiError } from '../errors';
import { postJson } from './http';
import { renderSchemaInstruction, toGeminiSchema, UnsupportedSchemaError } from '../schema';
import type {
  AiProviderId,
  ChatMessage,
  GenerateRequest,
  GenerateResult,
  JsonSchemaObject,
  LlmProvider,
  TokenUsage,
} from '../types';

interface GeminiPart {
  text?: string;
}

interface GeminiCandidate {
  content?: { parts?: GeminiPart[]; role?: string };
  finishReason?: string;
}

interface GeminiResponse {
  modelVersion?: string;
  candidates?: GeminiCandidate[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    totalTokenCount?: number;
  };
}

function readUsage(response: GeminiResponse): TokenUsage {
  const usage = response.usageMetadata;
  if (!usage) return {};
  const out: TokenUsage = {};
  if (typeof usage.promptTokenCount === 'number') out.promptTokens = usage.promptTokenCount;
  // Los tokens de "thinking" son output facturable: se suman a completionTokens.
  const completion =
    (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0);
  if (usage.candidatesTokenCount !== undefined || usage.thoughtsTokenCount !== undefined) {
    out.completionTokens = completion;
  }
  if (typeof usage.totalTokenCount === 'number') out.totalTokens = usage.totalTokenCount;
  return out;
}

/** Mensajes de chat -> `systemInstruction` + `contents` con roles user/model. */
function splitMessages(messages: ChatMessage[]): {
  systemInstruction: string | null;
  contents: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }>;
} {
  const systemChunks: string[] = [];
  const contents: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }> = [];

  for (const message of messages) {
    if (message.role === 'system') {
      systemChunks.push(message.content);
      continue;
    }
    contents.push({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: message.content }],
    });
  }

  return {
    systemInstruction: systemChunks.length > 0 ? systemChunks.join('\n\n') : null,
    contents,
  };
}

function appendToSystem(base: string | null, extra: string): string {
  return base === null ? extra : `${base}\n\n${extra}`;
}

export class GeminiProvider implements LlmProvider {
  readonly id: AiProviderId = 'google';
  readonly model: string;

  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly thinkingBudget: number | undefined;

  constructor(config: AiConfig) {
    this.apiKey = config.GOOGLE_AI_API_KEY;
    this.baseUrl = config.GOOGLE_AI_BASE_URL.replace(/\/+$/, '');
    this.model = config.GOOGLE_AI_MODEL;
    this.timeoutMs = config.AI_REQUEST_TIMEOUT_MS;
    this.thinkingBudget = config.GOOGLE_AI_THINKING_BUDGET;
  }

  isConfigured(): boolean {
    return typeof this.apiKey === 'string' && this.apiKey.length > 0;
  }

  private assertConfigured(model: string): void {
    if (!this.isConfigured()) {
      throw new AiError({
        code: 'not_configured',
        message: 'VEKTORA/AI: GOOGLE_AI_API_KEY no está definida',
        provider: this.id,
        model,
      });
    }
  }

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    this.assertConfigured(this.model);

    let nativeSchema: JsonSchemaObject | null = null;
    let degraded = false;

    if (request.jsonSchema !== undefined) {
      try {
        nativeSchema = toGeminiSchema(request.jsonSchema);
      } catch (error) {
        if (!(error instanceof UnsupportedSchemaError)) throw error;
        nativeSchema = null;
        degraded = true;
      }
    }

    try {
      return await this.callGenerate(request, nativeSchema, degraded);
    } catch (error) {
      // Un 400 con responseSchema casi siempre es un rechazo del esquema: se reintenta
      // una vez sin structured output nativo antes de ceder el turno al fallback.
      const schemaRejected =
        nativeSchema !== null && isAiError(error) && error.code === 'bad_request';
      if (!schemaRejected) throw error;
      return await this.callGenerate(request, null, true);
    }
  }

  private async callGenerate(
    request: GenerateRequest,
    nativeSchema: JsonSchemaObject | null,
    degraded: boolean,
  ): Promise<GenerateResult> {
    const split = splitMessages(request.messages);
    let systemInstruction = split.systemInstruction;

    if (request.jsonSchema !== undefined && nativeSchema === null) {
      systemInstruction = appendToSystem(
        systemInstruction,
        renderSchemaInstruction(request.jsonSchema),
      );
    }

    const generationConfig: Record<string, unknown> = {};
    if (request.temperature !== undefined) generationConfig['temperature'] = request.temperature;
    if (request.maxOutputTokens !== undefined) {
      generationConfig['maxOutputTokens'] = request.maxOutputTokens;
    }
    if (request.json === true || request.jsonSchema !== undefined) {
      generationConfig['responseMimeType'] = 'application/json';
    }
    if (nativeSchema !== null) generationConfig['responseSchema'] = nativeSchema;
    if (this.thinkingBudget !== undefined) {
      generationConfig['thinkingConfig'] = { thinkingBudget: this.thinkingBudget };
    }

    const body: Record<string, unknown> = { contents: split.contents };
    if (systemInstruction !== null) {
      body['systemInstruction'] = { parts: [{ text: systemInstruction }] };
    }
    if (Object.keys(generationConfig).length > 0) body['generationConfig'] = generationConfig;

    const response = await postJson({
      url: `${this.baseUrl}/models/${encodeURIComponent(this.model)}:generateContent`,
      body,
      headers: { 'x-goog-api-key': this.apiKey ?? '' },
      timeoutMs: this.timeoutMs,
      provider: this.id,
      model: this.model,
      signal: request.signal,
    });

    const payload = (response.json ?? {}) as GeminiResponse;

    const blockReason = payload.promptFeedback?.blockReason;
    if (blockReason !== undefined) {
      throw new AiError({
        code: 'blocked',
        message: `VEKTORA/AI: Gemini bloqueó el prompt (${blockReason})`,
        provider: this.id,
        model: this.model,
        details: payload.promptFeedback,
      });
    }

    const candidate = payload.candidates?.[0];
    const finishReason = candidate?.finishReason;

    if (finishReason === 'MAX_TOKENS') {
      throw new AiError({
        code: 'truncated',
        message: 'VEKTORA/AI: Gemini cortó la respuesta por límite de tokens',
        provider: this.id,
        model: this.model,
        details: { finishReason, usage: payload.usageMetadata },
      });
    }
    if (finishReason === 'SAFETY' || finishReason === 'PROHIBITED_CONTENT') {
      throw new AiError({
        code: 'blocked',
        message: `VEKTORA/AI: Gemini bloqueó la respuesta (${finishReason})`,
        provider: this.id,
        model: this.model,
        details: { finishReason },
      });
    }

    const text = (candidate?.content?.parts ?? [])
      .map((part) => part.text ?? '')
      .join('')
      .trim();

    if (text === '') {
      throw new AiError({
        code: 'invalid_json',
        message: 'VEKTORA/AI: Gemini devolvió contenido vacío',
        provider: this.id,
        model: this.model,
        details: payload,
      });
    }

    return {
      text,
      model: payload.modelVersion ?? this.model,
      usage: readUsage(payload),
      ...(finishReason === undefined ? {} : { finishReason }),
      raw: response.json,
      ...(degraded ? { schemaDegraded: true } : {}),
    };
  }
}
