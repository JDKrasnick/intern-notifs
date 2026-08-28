import { describe, expect, it } from 'vitest';
import { normalizeUrl, postingIdentity, postingIdentityKey, roleFamilyFingerprint } from '../src/core/normalize.js';
import { buildPostingIdentity, providerPostingReference, resolvePostingAliases } from '../src/identity/posting.js';
import { providerEvidenceForOccurrence, reviewedProviderUrlReference } from '../src/identity/reviewed-provider.js';

describe('posting identity', () => {
  it.each([
    ['Ashby', 'https://jobs.ashbyhq.com/OpusClip/501d374d-7d4f-4889-bc53-0a1fd16253ea/application?embed=true', 'https://jobs.ashbyhq.com/opusclip/501d374d-7d4f-4889-bc53-0a1fd16253ea'],
    ['Greenhouse', 'https://boards.greenhouse.io/AssuredGuaranty/jobs/8700953002?gh_jid=8700953002', 'https://job-boards.greenhouse.io/assuredguaranty/jobs/8700953002'],
    ['Greenhouse gh_jid', 'https://boards.greenhouse.io/AssuredGuaranty?gh_jid=8700953002&utm_source=feed', 'https://job-boards.greenhouse.io/assuredguaranty/jobs/8700953002'],
    ['Workday', 'https://micron.wd1.myworkdayjobs.com/External/job/Boise/Intern_JR108448', 'https://micron.wd1.myworkdayjobs.com/external/job/Boise/renamed-role_JR108448'],
    ['Workday route host', 'https://micron.wd1.myworkdayjobs.com/External/job/Boise/Intern_JR108448', 'https://micron.wd5.myworkdayjobs.com/en-US/External/job/Intern_JR108448'],
    ['ByteDance family', 'https://lifeattiktok.com/search/7672883129493948677', 'https://jobs.bytedance.com/en/position/7672883129493948677/detail'],
  ])('matches %s URL aliases', (_provider, left, right) => {
    expect(postingIdentity(left)).toBe(postingIdentity(right));
    expect(postingIdentityKey(left)).toBe(postingIdentityKey(right));
  });

  it('keeps distinct provider requisitions separate even when their titles would match', () => {
    expect(postingIdentity('https://lifeattiktok.com/search/7672569081632229685')).not.toBe(postingIdentity('https://lifeattiktok.com/search/7672562486917286149'));
  });

  it('does not treat provider-ID prefixes or malformed UUID slugs as authoritative aliases', () => {
    const leverBackend = buildPostingIdentity({ applicationUrl: 'https://jobs.lever.co/acme/deadbeef/backend' });
    const leverFrontend = buildPostingIdentity({ applicationUrl: 'https://jobs.lever.co/acme/deadbeef/frontend' });
    const ashbyBackend = buildPostingIdentity({ applicationUrl: 'https://jobs.ashbyhq.com/acme/deadbeef/backend' });
    const ashbyFrontend = buildPostingIdentity({ applicationUrl: 'https://jobs.ashbyhq.com/acme/deadbeef/frontend' });
    expect(leverBackend.provider).toBe('unknown');
    expect(ashbyBackend.provider).toBe('unknown');
    expect(leverBackend.canonicalJobId).not.toBe(leverFrontend.canonicalJobId);
    expect(ashbyBackend.canonicalJobId).not.toBe(ashbyFrontend.canonicalJobId);
  });

  it('accepts only reviewed provider suffixes after an immutable posting ID', () => {
    const uuid = '501d374d-7d4f-4889-bc53-0a1fd16253ea';
    for (const url of [
      `https://jobs.lever.co/acme/${uuid}/backend`,
      `https://jobs.ashbyhq.com/acme/${uuid}/frontend`,
      'https://job-boards.greenhouse.io/acme/jobs/123/backend',
      'https://jobs.bytedance.com/en/position/123/frontend',
    ]) expect(providerPostingReference(url).provider).toBe('unknown');
    expect(providerPostingReference(`https://jobs.lever.co/acme/${uuid}/apply`).provider).toBe('lever');
    expect(providerPostingReference(`https://jobs.ashbyhq.com/acme/${uuid}/application`).provider).toBe('ashby');
    expect(providerPostingReference('https://jobs.bytedance.com/en/position/123/detail').provider).toBe('bytedance');
  });

  it('groups location variants only as a soft role family', () => {
    expect(roleFamilyFingerprint('🔥 TikTok', 'Product Manager Intern - Ads Interface and Platform', 'summer-2027')).toBe(roleFamilyFingerprint('TikTok', 'Product Manager Internship - Ads Interface and Platform', 'Summer 2027'));
  });

  it('canonicalizes provider presentation routes without dropping meaningful query data', () => {
    expect(normalizeUrl('HTTPS://Jobs.AshbyHQ.com/Acme/ABC-123/application/?embed=true&utm_source=x#apply'))
      .toBe('https://jobs.ashbyhq.com/acme/abc-123');
    expect(normalizeUrl('https://jobs.example.test/opening/?department=eng&ref=feed&candidate=42'))
      .toBe('https://jobs.example.test/opening?candidate=42&department=eng');
  });

  it('builds a stable exact identity and scopes authoritative requisitions to an employer', () => {
    const identity = buildPostingIdentity({
      applicationUrl: 'https://boards.greenhouse.io/Acme/jobs/123?gh_jid=123',
      observedUrls: ['https://job-boards.greenhouse.io/acme/jobs/123?utm_source=community'],
      employerId: 'acme',
      employerRequisitionId: ' SWE-42 ',
      employerRequisitionAuthoritative: true,
      reviewedProviderReferences: [{ provider: 'greenhouse', tenant: 'acme', postingId: '123' }],
    });
    expect(identity).toMatchObject({
      provider: 'greenhouse',
      tenant: 'acme',
      providerPostingId: '123',
      canonicalApplicationUrl: 'https://job-boards.greenhouse.io/acme/jobs/123',
    });
    expect(identity).not.toHaveProperty('employerId');
    expect(identity.aliases.map((item) => item.value)).toContain('requisition:acme:swe-42');
    expect(buildPostingIdentity({ applicationUrl: 'https://job-boards.greenhouse.io/acme/jobs/123', reviewedProviderReferences: [{ provider: 'greenhouse', tenant: 'acme', postingId: '123' }] }).canonicalJobId)
      .toBe(identity.canonicalJobId);
  });

  it('keeps a reviewed board token provider-scoped instead of treating it as an employer', () => {
    const evidence = providerEvidenceForOccurrence(
      'greenhouse-axontalentcommunity',
      '8675309',
      ['https://job-boards.greenhouse.io/axontalentcommunity/jobs/8675309'],
    );
    expect(evidence).toEqual({
      provider: 'greenhouse',
      tenant: 'axontalentcommunity',
      postingId: '8675309',
      sourceId: 'greenhouse-axontalentcommunity',
      urls: ['https://job-boards.greenhouse.io/axontalentcommunity/jobs/8675309'],
    });
    const identity = buildPostingIdentity({
      applicationUrl: 'https://job-boards.greenhouse.io/axontalentcommunity/jobs/8675309',
      providerEvidence: evidence,
    });
    expect(identity).toMatchObject({ provider: 'greenhouse', tenant: 'axontalentcommunity', providerPostingId: '8675309' });
    expect(identity).not.toHaveProperty('employerId');
  });

  it('deterministically creates, merges, or quarantines alias claims', () => {
    const identity = buildPostingIdentity({
      applicationUrl: 'https://jobs.ashbyhq.com/acme/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      observedUrls: ['https://careers.acme.test/jobs/a?utm_source=feed'],
    });
    expect(resolvePostingAliases(identity, new Map())).toMatchObject({ outcome: 'create', canonicalJobId: identity.canonicalJobId });
    const firstAlias = identity.aliases[0]!.value;
    expect(resolvePostingAliases(identity, new Map([[firstAlias, 'existing-job']]))).toMatchObject({ outcome: 'merge', canonicalJobId: 'existing-job' });
    const claims = new Map(identity.aliases.slice(0, 2).map((item, index) => [item.value, `job-${index}`]));
    expect(resolvePostingAliases(identity, claims)).toMatchObject({
      outcome: 'quarantine',
      conflictingCanonicalJobIds: ['job-0', 'job-1'],
      reason: 'aliases-resolve-to-different-jobs',
    });
  });

  it('quarantines two immutable IDs from the same provider tenant even before claims exist', () => {
    const identity = buildPostingIdentity({
      applicationUrl: 'https://jobs.lever.co/acme/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      observedUrls: ['https://jobs.lever.co/acme/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'],
      reviewedProviderReferences: [
        { provider: 'lever', tenant: 'acme', postingId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' },
        { provider: 'lever', tenant: 'acme', postingId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' },
      ],
    });
    expect(resolvePostingAliases(identity, new Map())).toMatchObject({ outcome: 'quarantine', reason: 'multiple-immutable-provider-postings' });
  });

  it('recognizes a reviewed DRW custom route but not an arbitrary lookalike host', () => {
    expect(reviewedProviderUrlReference('https://www.drw.com/work-at-drw/listings/quantitative-research-intern-3413670?utm_source=list')).toMatchObject({
      outcome: 'match', reference: { provider: 'greenhouse', tenant: 'drweng', postingId: '3413670', sourceId: 'greenhouse-drweng', customHost: true },
    });
    expect(reviewedProviderUrlReference('https://drw.example.test/work-at-drw/listings/quantitative-research-intern-3413670')).toEqual({ outcome: 'none' });
  });

  it('recognizes only the immutable public ID on a reviewed Roblox custom host', () => {
    expect(reviewedProviderUrlReference('https://careers.roblox.com/jobs/7116940/software-engineering-intern?gh_jid=7116940')).toMatchObject({
      outcome: 'match', reference: { provider: 'greenhouse', tenant: 'roblox', postingId: '7116940', sourceId: 'greenhouse-roblox', customHost: true },
    });
    expect(reviewedProviderUrlReference('https://careers.roblox.com/jobs/software-engineering-intern')).toEqual({ outcome: 'none' });
    expect(reviewedProviderUrlReference('https://careers.roblox.com/jobs/7116940?gh_jid=7116999')).toMatchObject({ outcome: 'conflict' });
  });

  it('quarantines aliases that cross provider tenants or providers', () => {
    const identity = buildPostingIdentity({
      applicationUrl: 'https://job-boards.greenhouse.io/figma/jobs/123',
      reviewedProviderReferences: [
        { provider: 'greenhouse', tenant: 'figma', postingId: '123' },
        { provider: 'greenhouse', tenant: 'spacex', postingId: '123' },
      ],
    });
    expect(resolvePostingAliases(identity, new Map())).toMatchObject({ outcome: 'quarantine', reason: 'provider-scope-mismatch' });
  });

  it('quarantines conflicting authoritative requisition scopes', () => {
    const identity = buildPostingIdentity({
      applicationUrl: 'https://careers.acme.test/jobs/one',
      employerId: 'acme',
      employerRequisitionId: 'REQ-1',
      employerRequisitionAuthoritative: true,
    });
    identity.aliases.push({ kind: 'employer-requisition', value: 'requisition:acme:req-2' });
    expect(resolvePostingAliases(identity, new Map())).toMatchObject({
      outcome: 'quarantine',
      reason: 'multiple-authoritative-requisitions',
    });
  });
});
