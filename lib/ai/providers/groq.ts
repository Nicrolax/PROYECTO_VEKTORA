/**
 * VEKTORA · FASE 2 — Adaptador de Groq (proveedor primario).
 *
 * Groq expone una API compatible con OpenAI: `POST {base}/chat/completions`.
 * Para salida estructurada se usa `response_format: { type: 'json_object' }`, que
 * `llama-3.3-70b-versatile` soporta, y el JSON Schema viaja en el system prompt. No se
 * usa `json_schema` nativo porque su disponibilidad depende del modelo y un 400 por
 * capacidad ausente costaría un reintento entero.
 */

import type { AiConfig } from '../config';
import { AiError } from '../errors';
import { postJson } from './http';
import { renderSchemaInstruction } from '../schema';
import type {
  AiProviderId,
  ChatMessage,
  GenerateRequest,
  GenerateResult,
  LlmProvider,
  TokenUsage,
} from '../types';

interface GroqChoice {
  message?: { content?: string | null } | undefined;
  finish_reason?: string | undefined;
}

interface GroqResponse {
  model?: string;
  choices?: GroqChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

function readUsage(response: GroqResponse): TokenUsage {
  const usage = response.usage;
  if (!usage) return {};
  const out: TokenUsage = {};
  if (typeof usage.prompt_tokens === 'number') out.promptTokens = usage.prompt_tokens;
  if (typeof usage.completion_tokens === 'number') out.completionTokens = usage.completion_tokens;
  if (typeof usage.total_tokens === 'number') out.totalTokens = usage.total_tokens;
  return out;
}

/** Inyecta el esquema en el mensaje de sistema (creándolo si no existe). */
function withSchemaInSystem(
  messages: ChatMessage[],
  instruction: string,
): ChatMessage[] {
  const index = messages.findIndex((message) => message.role === 'system');
  if (index === -1) {
    return [{ role: 'system', content: instruction }, ...messages];
  }
  const existing = messages[index];
  if (existing === undefined) return messages;
  const merged: ChatMessage = {
    role: 'system',
    content: `${existing.content}\n\n${instruction}`,
  };
  const copy = [...messages];
  copy[index] = merged;
  return copy;
}

export class GroqProvider implements LlmProvider {
  readonly id: AiProviderId = 'groq';
  readonly model: string;

  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(config: AiConfig) {
    this.apiKey = config.GROQ_API_KEY;
    this.baseUrl = config.GROQ_BASE_URL.replace(/\/+$/, '');
    this.model = config.GROQ_MODEL;
    this.timeoutMs = config.AI_REQUEST_TIMEOUT_MS;
  }

  isConfigured(): boolean {
    return typeof this.apiKey === 'string' && this.apiKey.length > 0;
  }

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    if (!this.isConfigured()) {
      throw new AiError({
        code: 'not_configured',
        message: 'VEKTORA/AI: GROQ_API_KEY no está definida',
        provider: this.id,
        model: this.model,
      });
    }

    const messages =
      request.jsonSchema === undefined
        ? request.messages
        : withSchemaInSystem(request.messages, renderSchemaInstruction(request.jsonSchema));

    const body: Record<string, unknown> = {
      model: this.model,
      messages: messages.map((message) => ({ role: message.role, content: message.content })),
      stream: false,
    };
    if (request.temperature !== undefined) body['temperature'] = request.temperature;
    if (request.maxOutputTokens !== undefined) body['max_tokens'] = request.maxOutputTokens;
    if (request.json === true || request.jsonSchema !== undefined) {
      body['response_format'] = { type: 'json_object' };
    }

    const response = await postJson({
      url: `${this.baseUrl}/chat/completions`,
      body,
      headers: { authorization: `Bearer ${this.apiKey ?? ''}` },
      timeoutMs: this.timeoutMs,
      provider: this.id,
      model: this.model,
      signal: request.signal,
    });

    const payload = (response.json ?? {}) as GroqResponse;
    const choice = payload.choices?.[0];
    const text = choice?.message?.content ?? '';
    const finishReason = choice?.finish_reason;

    if (finishReason === 'length') {
      throw new AiError({
        code: 'truncated',
        message: 'VEKTORA/AI: Groq cortó la respuesta por límite de tokens',
        provider: this.id,
        model: this.model,
        details: { finishReason },
      });
    }

    if (text.trim() === '') {
      throw new AiError({
        code: 'invalid_json',
        message: 'VEKTORA/AI: Groq devolvió contenido vacío',
        provider: this.id,
        model: this.model,
        details: payload,
      });
    }

    return {
      text,
      model: payload.model ?? this.model,
      usage: readUsage(payload),
      ...(finishReason === undefined ? {} : { finishReason }),
      raw: response.json,
    };
  }
}
