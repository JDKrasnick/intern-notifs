import { describe, expect, it, vi } from 'vitest';
import { createMetadataAcquirer, metadataApiRoute, parseMetadataApiResponse } from '../src/metadata-acquisition.js';
import { extractPostingMetadataEvidence, compensationFromRanges, reconcileRoleMetadata } from '../src/role-metadata.js';
import { exactPostingRecoveryUrl, renderedDescriptionReady } from '../src/rendered-destination-evidence.js';
import { compareMetadataCohort, decodeMetadataCursor, encodeMetadataCursor, metadataFieldOutcomes } from '../src/metadata-audit.js';
import type { ProviderIdentity } from '../src/types.js';

const uuid = 'ef725594-42dd-4f0d-ba8e-df8179dbc6cb';
const identity = (provider: ProviderIdentity['provider'], postingId = uuid): ProviderIdentity => ({ provider, postingId, tenant: 'acme', sourceId: 'github-discovery', sourceUrl: 'https://github.test/jobs' });
const extract = (artifact: Parameters<typeof extractPostingMetadataEvidence>[0]['artifact']) => extractPostingMetadataEvidence({ artifact, sourceClass: 'official-ats', sourceId: 'test', sourceUrl: 'https://api.example.test/job', observedAt: '2026-09-05T00:00:00Z', exactPosting: true });

describe('identity-bound public metadata APIs', () => {
  it('preserves degree-specific nested HTML pay rows through acquisition and reconciliation', () => {
    const artifact = parseMetadataApiResponse(identity('greenhouse', '123'), 'greenhouse-api', { id: 123, title: 'Engineering Intern',
      content: '<h3>Compensation and Benefits</h3><ul><li>The compensation for this role:<ul><li>Engineering Intern/Undergraduate: $30/hour</li><li>Engineering Intern/Masters: $32.50/hour</li><li>Engineering Intern/PhD: $35/hour</li></ul></li></ul>' });
    const result = reconcileRoleMetadata(extract(artifact!));
    expect(result.conflicts).toEqual([]);
    expect(result.compensation?.ranges).toHaveLength(3);
    expect(result.compensation?.ranges).toEqual(expect.arrayContaining([
      expect.objectContaining({ minAmount: 30, applicableEducationLevels: ['undergraduate'] }),
      expect.objectContaining({ minAmount: 32.5, applicableEducationLevels: ['masters'] }),
      expect.objectContaining({ minAmount: 35, applicableEducationLevels: ['doctoral'] }),
    ]));
    expect(result.compensation?.minHourlyUSD).toBeUndefined();
  });
  it('retains encoded ranges and publisher level labels without inventing periods', () => {
    for (const [content, expected] of [
      ['<h3>US Salary Range</h3><p>$90,000 &amp;mdash; $110,000 USD</p>', [{ minAmount: 90000, maxAmount: 110000, currency: 'USD' }]],
      ['<h3>Compensation and Benefits:</h3><p>Level 1: $140,000 - $175,000</p><p>Level 2: $160,000 - $210,000</p>', [{ minAmount: 140000, maxAmount: 175000, applicabilityLabel: 'Level 1' }, { minAmount: 160000, maxAmount: 210000, applicabilityLabel: 'Level 2' }]],
      ['<p>Compensation Range(s):</p><p>Level I - Minimum $18.00 - Maximum $20.00</p><p>Levell II - Minimum $21.00 - Maximum $23.00</p>', [{ minAmount: 18, maxAmount: 20, applicabilityLabel: 'Level I' }, { minAmount: 21, maxAmount: 23, applicabilityLabel: 'Levell II' }]],
    ] as const) {
      const artifact = parseMetadataApiResponse(identity('greenhouse', '123'), 'greenhouse-api', { id: 123, title: 'Engineering Intern', content });
      const result = reconcileRoleMetadata(extract(artifact!));
      expect(result.conflicts).toEqual([]);
      expect(result.compensation?.ranges).toHaveLength(expected.length);
      expect(result.compensation?.ranges).toEqual(expect.arrayContaining(expected.map(range => expect.objectContaining({ ...range, period: 'unknown' }))));
    }
  });
  it('uses the observed Workday site and requisition, never a start-date publication guess', () => {
    const id = { ...identity('workday', 'r0248143'), tenant: 'bah' };
    expect(metadataApiRoute(id, 'https://bah.wd1.myworkdayjobs.com/en-US/BAH_Jobs/job/Rome-NY/Intern_R0248143')?.url)
      .toBe('https://bah.wd1.myworkdayjobs.com/wday/cxs/bah/BAH_Jobs/job/Rome-NY/Intern_R0248143');
    expect(metadataApiRoute(id, 'https://evil.test/BAH_Jobs/job/Rome-NY/Intern_R0248143')).toBeUndefined();
    expect(metadataApiRoute(id, 'https://bah.wd1.myworkdayjobs.com/BAH_Jobs/job/Rome-NY/Intern_R999')).toBeUndefined();
    const artifact = parseMetadataApiResponse(id, 'workday-api', { jobPostingInfo: { jobReqId: 'R0248143', title: 'Software Intern', jobDescription: 'Salary USD 30 per hour', startDate: '2026-09-04', endDate: '2026-12-02' } });
    expect(artifact).toMatchObject({ deadline: '2026-12-02' }); expect(artifact?.publishedAt).toBeUndefined();
    expect(parseMetadataApiResponse(id, 'workday-api', { jobPostingInfo: { jobReqId: 'R999', title: 'Software Intern', jobDescription: 'Salary USD 30 per hour' } })).toBeUndefined();
  });
  it('matches the entire Workday presentation suffix instead of merging requisitions', () => {
    const id = { ...identity('workday', 'jr340771-1'), tenant: 'salesforce' };
    const url = 'https://salesforce.wd12.myworkdayjobs.com/wday/cxs/salesforce/External_Career_Site/job/California/Intern_JR340771-1';
    const job = { jobReqId: 'JR340771', jobPostingId: 'Intern_JR340771-1', title: 'Software Intern', jobDescription: 'Salary USD 40 per hour' };
    expect(parseMetadataApiResponse(id, 'workday-api', { jobPostingInfo: job }, url)).toBeDefined();
    expect(parseMetadataApiResponse(id, 'workday-api', { jobPostingInfo: { ...job, jobPostingId: 'Intern_JR340771-2' } }, url)).toBeUndefined();
  });
  it('validates the SmartRecruiters company and excludes company-wide descriptions', () => {
    const route = metadataApiRoute(identity('unknown'), 'https://jobs.smartrecruiters.com/ALTEN/744000145558439-stage-data');
    expect(route?.url).toBe('https://api.smartrecruiters.com/v1/companies/ALTEN/postings/744000145558439');
    const payload = { id: '744000145558439', company: { identifier: 'ALTEN' }, name: 'Software Intern', jobAd: { sections: {
      companyDescription: { text: 'Our company pays USD 900000 per year' }, jobDescription: { text: 'Salary EUR 2000 per month' },
    } } };
    const artifact = parseMetadataApiResponse(route!.identity!, 'smartrecruiters-api', payload);
    expect(artifact?.text).not.toContain('900000');
    expect(parseMetadataApiResponse(route!.identity!, 'smartrecruiters-api', { ...payload, company: { identifier: 'different' } })).toBeUndefined();
  });
  it('requests Greenhouse transparency without application questions or a guessed period', () => {
    const id = identity('greenhouse', '123');
    expect(metadataApiRoute(id)?.url).toContain('pay_transparency=true');
    const artifact = parseMetadataApiResponse(id, 'greenhouse-api', { id: 123, title: 'Software Intern', content: 'Build things.',
      pay_input_ranges: [{ min_cents: 12350000, max_cents: 17000000, currency_type: 'USD', title: 'Salary Range' }] });
    expect(artifact).toBeDefined();
    const pay = compensationFromRanges(extract(artifact!)[0]!.compensationRanges ?? []);
    expect(pay.ranges).toMatchObject([{ minAmount: 123500, maxAmount: 170000, period: 'unknown', currency: 'USD' }]);
    expect(pay.minAnnualUSD).toBeUndefined();
    expect(parseMetadataApiResponse(id, 'greenhouse-api', { id: 999, title: 'Software Intern', content: 'Salary USD 100/hour' })).toBeUndefined();
  });
  it('retains Lever descriptions, lists, native bands and provider dates', () => {
    const artifact = parseMetadataApiResponse(identity('lever'), 'lever-api', { id: uuid, text: 'Software Intern', hostedUrl: `https://jobs.lever.co/acme/${uuid}`,
      descriptionPlain: 'Build things.', lists: [{ text: 'Requirements', content: 'Must hold a bachelors degree.' }],
      salaryRange: { currency: 'JPY', min: 2000, max: 4000, interval: 'per-hour-wage' }, createdAt: 1788566400000 });
    expect(artifact?.text).toContain('bachelors');
    expect(extract(artifact!)[0]?.compensationRanges).toMatchObject([{ minAmount: 2000, maxAmount: 4000, currency: 'JPY', period: 'hourly' }]);
    expect(parseMetadataApiResponse(identity('lever'), 'lever-api', { id: uuid, text: 'Software Intern', hostedUrl: `https://jobs.lever.co/another/${uuid}`, descriptionPlain: 'Build things' })).toBeUndefined();
  });
  it('selects exactly one Ashby posting without directory salary contamination', () => {
    const artifact = parseMetadataApiResponse(identity('ashby'), 'ashby-api', { jobs: [
      { id: 'other', title: 'Other role', compensation: { scrapeableCompensationSalarySummary: 'USD 900000/year' } },
      { id: uuid, title: 'Software Intern', descriptionPlain: 'Build things', jobUrl: `https://jobs.ashbyhq.com/acme/${uuid}`,
        compensation: { scrapeableCompensationSalarySummary: 'Salary EUR 2000 - 3000 per month' } },
    ] });
    expect(extract(artifact!)[0]?.compensationRanges).toMatchObject([{ currency: 'EUR', minAmount: 2000, maxAmount: 3000, period: 'monthly' }]);
  });
  it('rejects unreviewed tenants and unsupported API families', () => {
    expect(metadataApiRoute({ ...identity('lever'), tenant: '../another' })).toBeUndefined();
    expect(metadataApiRoute(identity('workday'))).toBeUndefined();
    expect(metadataApiRoute({ ...identity('greenhouse', '123'), tenant: undefined })).toBeUndefined();
  });
  it('accepts dotted Ashby board names without allowing path traversal', () => {
    expect(metadataApiRoute({ ...identity('ashby'), tenant: 'persona.ai' })?.url)
      .toBe('https://api.ashbyhq.com/posting-api/job-board/persona.ai?includeCompensation=true');
    for (const tenant of ['..', '.', '../acme', 'acme/other', 'acme%2fother', 'acme..other', 'acme?foo=bar']) {
      expect(metadataApiRoute({ ...identity('ashby'), tenant })).toBeUndefined();
    }
    expect(metadataApiRoute({ ...identity('greenhouse', '123'), tenant: 'persona.ai' })).toBeUndefined();
  });
  it('recovers only an exact observed Greenhouse embed identity', () => {
    const id = { ...identity('greenhouse', '8044334'), tenant: undefined };
    const url = 'https://job-boards.greenhouse.io/embed/job_app?for=towerresearchcapital&token=8044334&validityToken=transient';
    expect(metadataApiRoute(id, url)).toMatchObject({ method: 'greenhouse-api', identity: { tenant: 'towerresearchcapital', postingId: '8044334' } });
    expect(metadataApiRoute(id, url)?.url).not.toContain('transient');
    for (const candidate of [url.replace('8044334', '999'), url.replace('job-boards.greenhouse.io', 'evil.test'),
      `${url}&for=another`, `${url}&token=999`, url.replace('towerresearchcapital', '..%2Facme')]) {
      expect(metadataApiRoute(id, candidate)).toBeUndefined();
    }
    expect(metadataApiRoute({ ...id, tenant: 'another' }, url)?.identity).toBeUndefined();
  });
  it('coalesces duplicate batch requests, but validates each posting separately', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ jobs: [{ id: uuid, title: 'Intern', descriptionPlain: 'Build', jobUrl: `https://jobs.ashbyhq.com/acme/${uuid}` }] }));
    const acquire = createMetadataAcquirer(fetchImpl);
    const [first, second] = await Promise.all([acquire(identity('ashby')), acquire(identity('ashby', '12345678-1234-1234-1234-123456789012'))]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(first?.outcome).toBe('acquired'); expect(second?.outcome).toBe('identity-mismatch');
    expect(fetchImpl.mock.calls[0]).toBeDefined();
  });
  it('rejects HTML, rate limits, invalid JSON and oversized responses', async () => {
    for (const response of [new Response('<html>login</html>', { headers: { 'content-type': 'text/html' } }), new Response('', { status: 429 }),
      new Response('{', { headers: { 'content-type': 'application/json' } }), new Response(' '.repeat(2_000_001), { headers: { 'content-type': 'application/json' } })]) {
      const result = await createMetadataAcquirer(async () => response)(identity('greenhouse', '123'));
      expect(['failed', 'incomplete']).toContain(result?.outcome); expect(result?.artifact).toBeUndefined();
    }
  });
  it('uses the Worker-supported manual redirect mode and rejects redirect responses', async () => {
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(init?.redirect).toBe('manual');
      return new Response(null, { status: 302, headers: { Location: 'https://unrelated.test/job' } });
    });
    expect(await createMetadataAcquirer(fetchImpl)(identity('greenhouse', '123')))
      .toMatchObject({ outcome: 'failed', status: 302 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('coverage accounting and moved postings', () => {
  it('uses shell-safe round-trippable collection cursors', () => {
    const cursor = encodeMetadataCursor('job-1', 'github-source');
    expect(cursor).not.toContain('\0');
    expect(decodeMetadataCursor(cursor)).toBe('job-1\0github-source');
    expect(() => decodeMetadataCursor('garbage')).toThrow('Invalid metadata cursor');
  });
  it('waits through shells and recognizes loaded descriptions or terminal states', () => {
    expect(renderedDescriptionReady('Software Engineering Intern', 'Loading…')).toBe(false);
    expect(renderedDescriptionReady('Software Engineering Intern', 'Careers '.repeat(100))).toBe(false);
    expect(renderedDescriptionReady('Software Engineering Intern', 'Software Engineering Intern. Build and test software. '.repeat(20))).toBe(true);
    for (const state of ['This job has expired', 'Under maintenance', 'Sign in to continue']) expect(renderedDescriptionReady('Software Engineering Intern', state)).toBe(true);
  });
  it('recovers only one observed same-origin exact-ID path', () => {
    const url = 'https://www.zipline.com/open-roles?gh_jid=7978843003';
    expect(exactPostingRecoveryUrl(url, '7978843003', ['/open-roles/7978843003', '/open-roles/999'])).toBe('https://www.zipline.com/open-roles/7978843003');
    expect(exactPostingRecoveryUrl(url, '7978843003', ['https://other.test/jobs/7978843003'])).toBeUndefined();
    expect(exactPostingRecoveryUrl(url, '7978843003', ['/jobs/7978843003', '/open-roles/7978843003'])).toBeUndefined();
    expect(exactPostingRecoveryUrl(url, '7978843003', ['/open-roles?gh_jid=7978843003'])).toBeUndefined();
  });
  it('does not claim non-disclosure from parser absence or a failed acquisition', () => {
    expect(metadataFieldOutcomes({ evidence: [], acquired: true, complete: true }).compensation).toBe('inspection-pending');
    expect(metadataFieldOutcomes({ evidence: [], acquired: true, complete: false }).compensation).toBe('incomplete-artifact');
    expect(metadataFieldOutcomes({ evidence: [], acquired: false, complete: false }).compensation).toBe('acquisition-failed');
    expect(metadataFieldOutcomes({ evidence: [], acquired: true, complete: true, reviewedAbsent: ['compensation'] }).compensation).toBe('no-disclosure-found');
  });
  it('retains closed or removed cohort members in the denominator', () => {
    expect(compareMetadataCohort([{ jobId: '1' }, { jobId: '2' }], [{ jobId: '1', compensation: { raw: 'USD 40/hour' } }])).toMatchObject({
      denominator: 2, counts: { 'gained-pay': 1, 'removed-or-closed': 1 },
    });
  });
});
