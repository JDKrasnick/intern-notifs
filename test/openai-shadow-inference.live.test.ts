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

  it('meets the labeled metadata status and canonical work-mode evaluation', async () => {
    const cases = [
      {
        title: 'Data Engineering Intern', incomplete: false,
        description: 'Work from our Chicago, IL office three days each week in a hybrid schedule. Benefits include a $500 wellness stipend.',
        expected: { compensation: 'not-stated', locations: 'present', workMode: 'present', housing: 'not-stated' }, workMode: 'hybrid',
      },
      {
        title: 'Security Intern', incomplete: false,
        description: 'This role is fully remote. Applicants must be pursuing a bachelor’s degree. Equipment and meals may be reimbursed.',
        expected: { compensation: 'not-stated', locations: 'not-stated', workMode: 'present', education: 'present' }, workMode: 'remote',
      },
      {
        title: 'Machine Learning Intern', incomplete: true,
        description: 'Location: Houston, TX – Onsite\nThe remainder of this posting was truncated.',
        expected: { compensation: 'incomplete', locations: 'present', workMode: 'present', housing: 'incomplete', timing: 'incomplete', education: 'incomplete', eligibility: 'incomplete' }, workMode: 'onsite',
      },
    ] as const;
    let truePositive = 0; let falsePositive = 0; let falseNegative = 0;
    for (const item of cases) {
      const input = normalizeExactPostingDescription(item.title, item.description, item.incomplete);
      const result = await inferOpenAIShadowExtraction(process.env.OPENAI_KEY!, input, shadowExtractionPrompt(input));
      const validation = validateShadowExtraction(result.response, input);
      expect(validation.failures, JSON.stringify(result.response)).toEqual([]);
      if (!validation.accepted) throw new Error(`Live extraction was rejected: ${JSON.stringify(result.response)}`);
      for (const [field, expected] of Object.entries(item.expected)) {
        const actual = validation.accepted.fields[field as keyof typeof validation.accepted.fields].status;
        if (expected === 'present' && actual === 'present') truePositive += 1;
        else if (expected !== 'present' && actual === 'present') falsePositive += 1;
        else if (expected === 'present') falseNegative += 1;
        expect(actual, `${item.title}: ${field}: ${JSON.stringify(result.response)}`).toBe(expected);
      }
      expect(validation.accepted.fields.workMode.value).toBe(item.workMode);
    }
    expect({ precision: truePositive / (truePositive + falsePositive), recall: truePositive / (truePositive + falseNegative) })
      .toEqual({ precision: 1, recall: 1 });
  }, 180_000);
});
