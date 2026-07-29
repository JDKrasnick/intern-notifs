import { describe, expect, it } from 'vitest';
import { inferLeverSeason, LeverPostingsAdapter, leverRequirements, mapLeverPosting } from '../src/sources/lever.js';

const posting = {
  id: 'job-1',
  text: 'Software Engineering Intern, Summer 2027',
  applyUrl: 'https://jobs.lever.co/acme/job-1/apply',
  hostedUrl: 'https://jobs.lever.co/acme/job-1',
  descriptionPlain: 'Applicants must be a U.S. citizen. A master\'s degree is required.',
  createdAt: 1_783_072_000_000,
  categories: { location: 'New York, NY', commitment: 'Internship' },
  workplaceType: 'hybrid'
};
const options = { id: 'lever-acme', company: 'Acme', site: 'acme' };

describe('LeverPostingsAdapter', () => {
  it('maps direct application URLs, Lever metadata, requirements, and a named season', () => {
    const mapped = mapLeverPosting(posting, options, '2026-07-20T00:00:00.000Z', 3);
    expect(mapped).toMatchObject({
      sourceId: 'lever-acme', document: 'job-1', sourceUrl: 'https://api.lever.co/v0/postings/acme?mode=json',
      row: 3, company: 'Acme', title: 'Software Engineering Intern, Summer 2027', location: 'New York, NY', season: 'summer-2027',
      applyUrl: 'https://jobs.lever.co/acme/job-1/apply', postedAt: '2026-07-03T09:46:40.000Z', workMode: 'hybrid',
      requirements: { requiresUsCitizenship: true, advancedDegreeRequired: true }
    });
  });
  it('emits only technical internship, co-op, and apprenticeship roles', () => {
    expect(mapLeverPosting({ ...posting, text: 'Finance Intern' }, options)).toBeUndefined();
    expect(mapLeverPosting({ ...posting, text: 'Software Engineer' }, options)).toBeUndefined();
    expect(mapLeverPosting({ ...posting, text: 'Software Engineering Co-op' }, options)).toMatchObject({ title: 'Software Engineering Co-op' });
    expect(mapLeverPosting({ ...posting, text: 'Security Engineering Apprenticeship' }, options)).toMatchObject({ title: 'Security Engineering Apprenticeship' });
  });
  it('infers named seasons and falls back to ongoing', () => {
    expect(inferLeverSeason('Machine Learning Intern', '2028 graduate internship')).toBe('2028');
    expect(inferLeverSeason('Software Engineering Intern', 'Join our early-career program.')).toBe('ongoing');
  });
  it('detects only source-declared citizenship and degree requirements', () => {
    expect(leverRequirements('Applicants must be U.S. citizens. A Ph.D. is required.')).toEqual({ requiresUsCitizenship: true, advancedDegreeRequired: true });
    expect(leverRequirements('We welcome all citizenships; our founders have master\'s degrees.')).toEqual({ requiresUsCitizenship: false, advancedDegreeRequired: false });
  });
  it('uses ETags and returns no-change without parsing', async () => {
    const calls: RequestInit[] = [];
    const adapter = new LeverPostingsAdapter({ ...options, fetchImpl: async (_url, init) => { calls.push(init ?? {}); return new Response(null, { status: 304 }); } });
    const result = await adapter.fetch({ sourceId: options.id, etag: '"lever-etag"', successfulFetches: 2, lastRowCount: 1 });
    expect(result.notModified).toBe(true);
    expect(result.listings).toEqual([]);
    expect(calls[0]?.headers).toEqual({ 'If-None-Match': '"lever-etag"' });
  });
  it('rejects malformed and error responses', async () => {
    const malformed = new LeverPostingsAdapter({ ...options, fetchImpl: async () => new Response('{', { status: 200 }) });
    await expect(malformed.fetch()).rejects.toThrow('malformed JSON');
    const error = new LeverPostingsAdapter({ ...options, fetchImpl: async () => new Response('nope', { status: 502 }) });
    await expect(error.fetch()).rejects.toThrow('Lever fetch failed (502)');
  });
});
