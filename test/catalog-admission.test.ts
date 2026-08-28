import { describe, expect, it } from 'vitest';
import { deriveCanonicalAdmission, evaluateCatalogAdmission, metadataCompleteness } from '../src/catalog-admission.js';
import { classifyDestination } from '../src/destination-verification.js';
import { inspectApplicationPage, type ApplicationPageEvidence } from '../src/core/application-url.js';
import type { CatalogAdmission, ProcessedListing, SourceOccurrence } from '../src/types.js';

function listing(overrides: Partial<ProcessedListing> = {}): ProcessedListing {
  return {
    sourceId: 'greenhouse-acme', provenance: 'official-ats', externalId: '1234567', document: '1234567',
    sourceUrl: 'https://boards-api.greenhouse.io/v1/boards/acme/jobs', row: 1, company: 'Acme',
    title: 'Software Engineering Intern', location: 'Remote', locations: ['Remote'], season: 'summer-2027',
    applyUrl: 'https://job-boards.greenhouse.io/acme/jobs/1234567', compensation: { raw: '' }, state: 'open',
    fetchedAt: '2026-08-26T12:00:00Z', technical: true,
    providerIdentity: { provider: 'greenhouse', sourceId: 'greenhouse-acme', tenant: 'acme', postingId: '1234567', sourceUrl: 'https://boards-api.greenhouse.io/v1/boards/acme/jobs' },
    employerEvidence: { authority: 'reviewed-registry', canonicalEmployer: { id: 'acme', displayName: 'Acme' } },
    metadataCompleteness: { complete: true, title: 'complete', location: 'complete' },
    ...overrides,
  };
}

function page(overrides: Partial<ApplicationPageEvidence> = {}): ApplicationPageEvidence {
  return {
    url: 'https://careers.acme.test/jobs/1234567', title: 'Software Engineering Intern — Acme',
    contentExcerpt: 'About the role. Responsibilities and qualifications for this software engineering internship.',
    confidence: { score: 90, level: 'high', recommendation: 'alert-eligible', signals: ['job-description language'] },
    ...overrides,
  };
}

describe('record-level catalog admission', () => {
  it('accepts blocked reviewed standard routes with the expected immutable posting ID', () => {
    const role = listing();
    const destination = classifyDestination({ listing: role, reachability: 'blocked', inspectedAt: '2026-08-26T12:00:00Z' });
    const admission = evaluateCatalogAdmission({ listing: role, destination, postingAttributed: true, evaluatedAt: '2026-08-26T12:00:00Z' });
    expect(destination.classification).toBe('posting-detail');
    expect(admission).toMatchObject({ catalogEligible: true, alertEligible: true, reasonCodes: [] });
  });

  it('quarantines generic employer labels such as Axon talent-community boards', () => {
    const role = listing({
      company: 'Join Our Talent Community',
      employerEvidence: { authority: 'reviewed-registry', canonicalEmployer: { id: 'axontalentcommunity', displayName: 'Join Our Talent Community' } },
    });
    const destination = classifyDestination({ listing: role, reachability: 'implied', inspectedAt: '2026-08-26T12:00:00Z' });
    expect(evaluateCatalogAdmission({ listing: role, destination, postingAttributed: true, evaluatedAt: '2026-08-26T12:00:00Z' }))
      .toMatchObject({ catalogEligible: false, reasonCodes: ['employer-generic-label'] });
  });

  it('distinguishes ignored Zipline-style shells from valid custom redirects', () => {
    const role = listing({
      applyUrl: 'https://www.zipline.com/open-roles?gh_jid=1234567',
      providerIdentity: { provider: 'greenhouse', sourceId: 'greenhouse-zipline', tenant: 'zipline', postingId: '1234567', sourceUrl: 'https://boards-api.greenhouse.io/v1/boards/zipline/jobs' },
    });
    const aggregate = classifyDestination({ listing: role, reachability: 'live', evidence: page({
      url: role.applyUrl, title: 'Open Roles at Zipline | Join Our Team', contentExcerpt: 'Browse every open role.',
      jobPostingCount: 16, postingIdPresent: false,
    }), inspectedAt: '2026-08-26T12:00:00Z', browserVisible: true });
    expect(aggregate.classification).toBe('aggregate-board');

    const valid = classifyDestination({ listing: { ...role, applyUrl: 'https://careers.acme.test/roles/software-intern' },
      reachability: 'live', evidence: page({ postingIdPresent: true, jobPostingCount: 1 }),
      inspectedAt: '2026-08-26T12:00:00Z', browserVisible: true });
    expect(valid.classification).toBe('posting-detail');
  });

  it('uses the required missing-location copy but rejects truncated and malformed display fields', () => {
    expect(metadataCompleteness({ title: 'Software Engineering Intern', locations: [] }))
      .toEqual({ complete: true, title: 'complete', location: 'not-specified' });
    expect(metadataCompleteness({ title: 'Embedded Engineering Intern (Summer', locations: ['South San Francisco, C...'] }))
      .toEqual({ complete: false, title: 'malformed', location: 'truncated' });
    expect(metadataCompleteness({ title: 'Software Engineering Intern…', locations: ['Remote'], titleRepaired: true }).title)
      .toBe('truncated');
    for (const title of ['Software Engineer II', 'Machine Learning Intern AI', 'Research Intern - Cedar Park, TX', 'Intern/ Graduate Software Engineer, NZ']) {
      expect(metadataCompleteness({ title, locations: ['Remote'] }), title)
        .toEqual({ complete: true, title: 'complete', location: 'complete' });
    }
  });

  it('does not accept an aggregate page from a matching role title alone', async () => {
    const role = listing({ applyUrl: 'https://careers.acme.test/open-roles' });
    const evidence = await inspectApplicationPage(role.applyUrl, async () => new Response(`<title>Open roles at Acme</title><main>
      <a href="/jobs/software-intern">Software Engineering Intern</a>
      <a href="/jobs/data-intern">Data Science Intern</a>
      <a href="/roles/design-intern">Product Design Intern</a>
    </main>`, { status: 200, headers: { 'content-type': 'text/html' } }));
    const destination = classifyDestination({
      listing: role,
      reachability: 'live',
      inspectedAt: '2026-08-26T12:00:00Z',
      browserVisible: true,
      evidence,
    });
    expect(destination.classification).toBe('aggregate-board');
    expect(evaluateCatalogAdmission({ listing: role, destination, postingAttributed: true, evaluatedAt: '2026-08-26T12:00:00Z' }))
      .toMatchObject({ catalogEligible: false, reasonCodes: ['destination-aggregate-board'] });
  });

  it('keeps exact posting evidence authoritative when the page links related roles', () => {
    const role = listing({ applyUrl: 'https://careers.acme.test/jobs/1234567' });
    const destination = classifyDestination({
      listing: role,
      reachability: 'live',
      inspectedAt: '2026-08-26T12:00:00Z',
      browserVisible: true,
      evidence: page({ postingIdPresent: true, distinctJobLinkCount: 4 }),
    });
    expect(destination.classification).toBe('posting-detail');
  });

  it('retains last-known-good handoff for seven days while pausing alerts', () => {
    const role = listing({ applyUrl: 'https://careers.acme.test/roles/1234567' });
    const goodDestination = classifyDestination({ listing: role, reachability: 'live', evidence: page({ postingIdPresent: true }), inspectedAt: '2026-08-20T12:00:00Z' });
    const previous = evaluateCatalogAdmission({ listing: role, destination: goodDestination, postingAttributed: true, evaluatedAt: '2026-08-20T12:00:00Z' });
    const unresolved = classifyDestination({ listing: role, reachability: 'unreachable', inspectedAt: '2026-08-26T12:00:00Z' });
    const grace = evaluateCatalogAdmission({ listing: role, destination: unresolved, postingAttributed: true, evaluatedAt: '2026-08-26T12:00:00Z', previous });
    expect(grace).toMatchObject({ catalogEligible: true, alertEligible: false, reasonCodes: ['destination-grace'], graceDeadline: '2026-09-02T12:00:00.000Z' });
    const expired = evaluateCatalogAdmission({ listing: role, destination: unresolved, postingAttributed: true, evaluatedAt: '2026-09-03T12:00:00Z', previous: grace });
    expect(expired).toMatchObject({ catalogEligible: false, alertEligible: false, reasonCodes: ['destination-unresolved'] });
  });

  it('lets valid official evidence repair a community row and blocks reviewed employer conflicts', () => {
    const valid = evaluateCatalogAdmission({ listing: listing(), destination: classifyDestination({ listing: listing(), reachability: 'implied', inspectedAt: '2026-08-26T12:00:00Z' }), postingAttributed: true, evaluatedAt: '2026-08-26T12:00:00Z' });
    const invalid: CatalogAdmission = { ...valid, canonicalEmployer: undefined, employerResolution: 'unresolved', catalogEligible: false, alertEligible: false, reasonCodes: ['employer-unresolved'] };
    const occurrence = (sourceId: string, provenance: SourceOccurrence['provenance'], admission: CatalogAdmission): SourceOccurrence => ({
      sourceId, provenance, externalId: sourceId, document: sourceId, sourceUrl: 'https://source.test', row: 1,
      company: admission.canonicalEmployer?.displayName ?? 'Community Acme', title: 'Software Engineering Intern', location: 'Remote',
      season: 'summer-2027', applyUrl: admission.destination.candidateUrl, compensation: { raw: '' }, state: 'open', admission,
    });
    expect(deriveCanonicalAdmission([
      occurrence('community', 'reviewed-community', invalid), occurrence('official', 'official-ats', valid),
    ], '2026-08-26T13:00:00Z')).toMatchObject({ catalogEligible: true, canonicalEmployer: { id: 'acme' } });

    const conflict = { ...valid, canonicalEmployer: { id: 'other', displayName: 'Other' } };
    expect(deriveCanonicalAdmission([
      occurrence('official-a', 'official-ats', valid), occurrence('official-b', 'official-structured', conflict),
    ], '2026-08-26T13:00:00Z')).toMatchObject({ employerResolution: 'conflict', catalogEligible: false, reasonCodes: ['employer-conflict'] });
  });

  it('derives an open role only from open occurrences while retaining a closed-history fallback', () => {
    const valid = evaluateCatalogAdmission({ listing: listing(), destination: classifyDestination({ listing: listing(), reachability: 'implied', inspectedAt: '2026-08-26T12:00:00Z' }), postingAttributed: true, evaluatedAt: '2026-08-26T12:00:00Z' });
    const invalid: CatalogAdmission = { ...valid, catalogEligible: false, alertEligible: false, reasonCodes: ['destination-aggregate-board'],
      destination: { ...valid.destination, classification: 'aggregate-board' } };
    const occurrence = (sourceId: string, state: SourceOccurrence['state'], admission: CatalogAdmission): SourceOccurrence => ({
      sourceId, provenance: 'official-ats', externalId: sourceId, document: sourceId, sourceUrl: 'https://source.test', row: 1,
      company: 'Acme', title: 'Software Engineering Intern', location: 'Remote', season: 'summer-2027',
      applyUrl: admission.destination.candidateUrl, compensation: { raw: '' }, state, admission,
    });
    expect(deriveCanonicalAdmission([
      occurrence('closed-good', 'closed', valid), occurrence('open-bad', 'open', invalid),
    ], '2026-08-26T13:00:00Z')).toMatchObject({ catalogEligible: false, reasonCodes: ['destination-aggregate-board'] });

    const conflict = { ...valid, canonicalEmployer: { id: 'other', displayName: 'Other' } };
    expect(deriveCanonicalAdmission([
      occurrence('closed-conflict', 'closed', conflict), occurrence('open-good', 'open', valid),
    ], '2026-08-26T13:00:00Z')).toMatchObject({ catalogEligible: true, canonicalEmployer: { id: 'acme' } });
    expect(deriveCanonicalAdmission([occurrence('closed-good', 'closed', valid)], '2026-08-26T13:00:00Z'))
      .toMatchObject({ catalogEligible: true, canonicalEmployer: { id: 'acme' } });
  });

  it('applies reviewed destination decisions before built-in route inference', () => {
    const role = listing();
    const rule = (decision: 'standard-provider-route' | 'browser-required' | 'aggregate-board' | 'blocked-accepted') => ({
      id: decision, host: 'job-boards.greenhouse.io', provider: 'greenhouse' as const, tenant: 'acme', decision,
      reviewedAt: '2026-08-26T00:00:00Z', reviewedBy: 'reviewer',
    });
    expect(classifyDestination({ listing: role, reachability: 'implied', inspectedAt: '2026-08-26T12:00:00Z', rule: rule('browser-required') }).classification)
      .toBe('unresolved');
    expect(classifyDestination({ listing: role, reachability: 'live', inspectedAt: '2026-08-26T12:00:00Z', rule: rule('browser-required'),
      evidence: page({ postingIdPresent: true, jobPostingCount: 1 }) }).classification).toBe('unresolved');
    expect(classifyDestination({ listing: role, reachability: 'live', inspectedAt: '2026-08-26T12:00:00Z', rule: rule('browser-required'),
      browserVisible: true, evidence: page({ postingIdPresent: true, jobPostingCount: 1 }) }).classification).toBe('posting-detail');
    expect(classifyDestination({ listing: role, reachability: 'live', inspectedAt: '2026-08-26T12:00:00Z', rule: rule('aggregate-board') }).classification)
      .toBe('aggregate-board');
    expect(classifyDestination({ listing: { ...role, applyUrl: 'https://job-boards.greenhouse.io/acme/custom/1234567' }, reachability: 'implied',
      inspectedAt: '2026-08-26T12:00:00Z', rule: rule('standard-provider-route') }).classification).toBe('posting-detail');
    expect(classifyDestination({ listing: role, reachability: 'blocked', inspectedAt: '2026-08-26T12:00:00Z', rule: rule('blocked-accepted') }).classification)
      .toBe('posting-detail');
    expect(classifyDestination({ listing: { ...role, applyUrl: 'https://job-boards.greenhouse.io/acme/careers' }, reachability: 'blocked',
      inspectedAt: '2026-08-26T12:00:00Z', rule: rule('blocked-accepted') }).classification).toBe('blocked-uninspectable');
  });
});
