import { describe, expect, it } from 'vitest';
import { normalizeUrl, postingIdentity, postingIdentityKey, roleFamilyFingerprint } from '../src/core/normalize.js';
import { buildPostingIdentity, providerPostingReference, resolvePostingAliases } from '../src/identity/posting.js';

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
    });
    expect(identity).toMatchObject({
      provider: 'greenhouse',
      tenant: 'acme',
      providerPostingId: '123',
      canonicalApplicationUrl: 'https://job-boards.greenhouse.io/acme/jobs/123',
    });
    expect(identity.aliases.map((item) => item.value)).toContain('requisition:acme:swe-42');
    expect(buildPostingIdentity({ applicationUrl: 'https://job-boards.greenhouse.io/acme/jobs/123' }).canonicalJobId)
      .toBe(identity.canonicalJobId);
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
    });
    expect(resolvePostingAliases(identity, new Map())).toMatchObject({ outcome: 'quarantine', reason: 'multiple-immutable-provider-postings' });
  });
});
