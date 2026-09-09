import type { NormalizedPostingInput } from '../src/shadow-extraction.js';
import type { ShadowInferenceResult } from './shadow-extraction.js';

const endpoint = 'https://api.openai.com/v1/chat/completions';
const maxResponseBytes = 100_000;
const requestTimeoutMs = 45_000;
const inputCentsPerMillionTokens = 15;
const outputCentsPerMillionTokens = 60;

const evidence = { type: 'array', items: { type: 'string' } } as const;
const qualifiers = { type: 'array', items: { type: 'string' } } as const;

function fieldSchema(presentValue: Record<string, unknown>) { return {
  anyOf: [
    {
      type: 'object', additionalProperties: false, required: ['value', 'status', 'evidence', 'qualifiers'],
      properties: { value: presentValue, status: { type: 'string', enum: ['present'] }, evidence, qualifiers },
    },
    {
      type: 'object', additionalProperties: false, required: ['value', 'status', 'evidence', 'qualifiers'],
      properties: {
        value: { type: 'null' }, status: { type: 'string', enum: ['not-stated', 'conflicting', 'incomplete'] },
        evidence, qualifiers,
      },
    },
  ],
} as const; }

const strings = {
  anyOf: [
    { type: 'string' },
    { type: 'array', items: { type: 'string' } },
  ],
};

const compensation = {
  type: 'array',
  items: {
    type: 'object', additionalProperties: false, required: ['min', 'max', 'currency', 'period'],
    properties: {
      min: { type: 'number' }, max: { type: 'number' }, currency: { type: 'string' },
      period: { type: 'string', enum: ['hour', 'day', 'week', 'month', 'year', 'one-time', 'unknown'] },
    },
  },
};

const responseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['classification', 'fields'],
  properties: {
    classification: {
      type: 'object', additionalProperties: false, required: ['technical', 'earlyCareer', 'disciplines'],
      properties: {
        technical: { type: 'string', enum: ['yes', 'no', 'unknown'] },
        earlyCareer: { type: 'string', enum: ['yes', 'no', 'unknown'] },
        disciplines: { type: 'array', items: { type: 'string' } },
      },
    },
    fields: {
      type: 'object', additionalProperties: false,
      required: ['compensation', 'locations', 'workMode', 'housing', 'timing', 'education', 'eligibility'],
      properties: {
        compensation: fieldSchema(compensation),
        locations: fieldSchema({ type: 'array', items: { type: 'string' } }),
        workMode: fieldSchema(strings), housing: fieldSchema(strings), timing: fieldSchema(strings),
        education: fieldSchema(strings), eligibility: fieldSchema(strings),
      },
    },
  },
} as const;

interface OpenAIChatCompletion {
  error?: { message?: string };
  choices?: Array<{ message?: { content?: string | null; refusal?: string | null } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

function integer(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
}

function billedCents(inputTokens: number, outputTokens: number): number {
  return Math.ceil((inputTokens * inputCentsPerMillionTokens + outputTokens * outputCentsPerMillionTokens) / 1_000_000);
}

async function boundedJson(response: Response): Promise<OpenAIChatCompletion> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxResponseBytes) throw new Error('OpenAI response is oversized');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maxResponseBytes) throw new Error('OpenAI response is oversized');
  return JSON.parse(new TextDecoder().decode(bytes)) as OpenAIChatCompletion;
}

export async function inferOpenAIShadowExtraction(
  apiKey: string,
  input: NormalizedPostingInput,
  prompt: { system: string; user: string },
  request: typeof fetch = fetch,
): Promise<ShadowInferenceResult> {
  if (!apiKey.trim()) throw new Error('OpenAI API key is unavailable');
  const response = await request(endpoint, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o-mini-2024-07-18',
      temperature: 0,
      max_tokens: 2_500,
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'shadow_metadata_extraction', strict: true, schema: responseSchema },
      },
      messages: [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ],
    }),
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  const completion = await boundedJson(response);
  if (!response.ok) {
    const detail = typeof completion.error?.message === 'string' ? `: ${completion.error.message.slice(0, 300)}` : '';
    throw new Error(`OpenAI request failed with status ${response.status}${detail}`);
  }
  const content = completion.choices?.[0]?.message?.content;
  const inputTokens = integer(completion.usage?.prompt_tokens);
  const outputTokens = integer(completion.usage?.completion_tokens);
  if (!content || inputTokens === undefined || outputTokens === undefined) throw new Error('OpenAI response is incomplete');
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { throw new Error('OpenAI response is not valid JSON'); }
  // The model only sees this bounded artifact and the versioned extraction
  // prompt. Preserve input in the signature to make that boundary explicit.
  void input;
  return { response: parsed, inputTokens, outputTokens, actualCostCents: billedCents(inputTokens, outputTokens) };
}
