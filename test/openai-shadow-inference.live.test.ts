import { describe, expect, it } from 'vitest';
import { inferOpenAIShadowExtraction } from '../cloudflare/openai-shadow-inference.js';
import { normalizeExactPostingDescription, shadowExtractionPrompt, validateShadowExtraction } from '../src/shadow-extraction.js';

const live = process.env.OPENAI_LIVE === '1' && Boolean(process.env.OPENAI_KEY);

describe.skipIf(!live)('OpenAI shadow inference live', () => {
  it('extracts explicit evidence and passes the production validator', async () => {
    const input = normalizeExactPostingDescription('Software Engineering Intern', [
      'This internship is based in Austin, Texas and is hybrid three days per week.',
      'Candidates must be enrolled in a bachelor’s degree program.',
      'The hourly pay range is $50 - $60 USD per hour.',
      'A $2,000 housing stipend is provided for the summer.',
    ].join('\n'));
    const result = await inferOpenAIShadowExtraction(process.env.OPENAI_KEY!, input, shadowExtractionPrompt(input));
    const validation = validateShadowExtraction(result.response, input);
    expect(validation.failures, JSON.stringify(result.response)).toEqual([]);
    expect(validation.accepted?.fields.compensation.status).toBe('present');
    expect(validation.accepted?.fields.locations.status).toBe('present');
    expect(validation.accepted?.fields.housing.status).toBe('present');
    expect(result.inputTokens).toBeGreaterThan(0);
    expect(result.outputTokens).toBeGreaterThan(0);
  }, 60_000);
});
