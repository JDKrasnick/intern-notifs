import { describe, expect, it } from 'vitest';
import { classifyDestination } from '../src/destination-verification.js';
import { combineRenderedFrameEvidence, type RenderedFrameSnapshot } from '../src/rendered-destination-evidence.js';
import type { ProcessedListing } from '../src/types.js';

const listing = (title = 'Software Engineering Intern'): ProcessedListing => ({
  sourceId: 'greenhouse-acme', provenance: 'official-ats', externalId: '1234567', document: '1234567',
  sourceUrl: 'https://boards-api.greenhouse.io/v1/boards/acme/jobs', row: 1, company: 'Acme', title,
  location: 'Remote', locations: ['Remote'], season: 'summer-2027',
  applyUrl: 'https://careers.acme.test/openings?gh_jid=1234567', compensation: { raw: '' }, state: 'open',
  fetchedAt: '2026-08-28T00:00:00Z', providerIdentity: { provider: 'greenhouse', sourceId: 'greenhouse-acme',
    tenant: 'acme', postingId: '1234567', sourceUrl: 'https://boards-api.greenhouse.io/v1/boards/acme/jobs' },
});

const frame = (overrides: Partial<RenderedFrameSnapshot> = {}): RenderedFrameSnapshot => ({
  url: 'https://careers.acme.test/openings?gh_jid=1234567', title: 'Careers at Acme',
  visibleText: 'Explore careers at Acme.', jobPostingCount: 0, distinctJobLinkCount: 0,
  applicationFormPresent: false, ...overrides,
});

describe('rendered destination frame evidence', () => {
  it('accepts a matching application rendered in a cross-origin child frame', () => {
    const role = listing();
    const evidence = combineRenderedFrameEvidence({ role: role.title, expectedPostingId: '1234567', frames: [
      frame(),
      frame({ url: 'https://job-boards.greenhouse.io/acme/jobs/1234567', parentUrl: role.applyUrl,
        title: 'Software Engineering Intern', visibleText: 'Software Engineering Intern Job ID 1234567 Remote Apply',
        structuredJobText: '{"@type":"JobPosting","identifier":"1234567"}', jobPostingCount: 1,
        applicationFormPresent: true }),
    ] })!;
    expect(evidence).toMatchObject({ evidenceFrameKind: 'child', postingIdPresent: true, jobPostingCount: 1,
      applicationFormPresent: true, renderedFrameCount: 2 });
    expect(classifyDestination({ listing: role, reachability: 'live', evidence, browserVisible: true,
      inspectedAt: '2026-08-28T00:00:00Z' }).classification).toBe('application-form');
  });

  it('does not close the selected posting from an expired related-role frame', () => {
    const role = listing();
    const evidence = combineRenderedFrameEvidence({ role: role.title, expectedPostingId: '1234567', frames: [
      frame({ title: role.title, visibleText: `${role.title} Job ID 1234567 Responsibilities Apply`,
        structuredJobText: '{"@type":"JobPosting","identifier":"1234567"}', jobPostingCount: 1,
        applicationFormPresent: true }),
      frame({ url: 'https://careers.acme.test/jobs/9999999', title: 'Related role',
        visibleText: 'This job has expired.', validThrough: '2020-01-01T00:00:00Z', jobPostingCount: 1 }),
    ] })!;
    expect(evidence.closureState).toBe('open');
    expect(evidence).not.toHaveProperty('validThrough');
  });

  it('does not treat a posting ID in an iframe URL as rendered posting proof', () => {
    const role = listing();
    const evidence = combineRenderedFrameEvidence({ role: role.title, expectedPostingId: '1234567', frames: [
      frame(), frame({ url: 'https://job-boards.greenhouse.io/acme/jobs/1234567', parentUrl: role.applyUrl,
        title: undefined, visibleText: undefined }),
    ] })!;
    expect(evidence.postingIdPresent).toBe(false);
    expect(classifyDestination({ listing: role, reachability: 'live', evidence, browserVisible: true,
      inspectedAt: '2026-08-28T00:00:00Z' }).classification).toBe('unresolved');
  });

  it('keeps blank self-referential embeds unresolved', () => {
    const role = listing();
    const evidence = combineRenderedFrameEvidence({ role: role.title, expectedPostingId: '1234567', frames: [
      frame(), frame({ parentUrl: role.applyUrl, visibleText: '', title: undefined }),
    ] })!;
    expect(evidence.selfReferentialFrame).toBe(true);
    expect(classifyDestination({ listing: role, reachability: 'live', evidence, browserVisible: true,
      inspectedAt: '2026-08-28T00:00:00Z' }).classification).toBe('unresolved');
  });

  it('keeps failed child-frame loads unresolved', () => {
    const role = listing();
    const evidence = combineRenderedFrameEvidence({ role: role.title, expectedPostingId: '1234567',
      frames: [frame()], failedFrameCount: 1 })!;
    expect(evidence).toMatchObject({ failedFrameCount: 1, renderedFrameCount: 1, postingIdPresent: false });
    expect(classifyDestination({ listing: role, reachability: 'live', evidence, browserVisible: true,
      inspectedAt: '2026-08-28T00:00:00Z' }).classification).toBe('unresolved');
  });

  it('rejects aggregate role lists and identical artifacts for different expected IDs', () => {
    const role = listing();
    const aggregate = combineRenderedFrameEvidence({ role: role.title, expectedPostingId: '1234567', frames: [frame({
      title: 'Open opportunities', visibleText: `Software Engineering Intern ${'Other role '.repeat(30)}`,
      distinctJobLinkCount: 12,
    })] })!;
    expect(classifyDestination({ listing: role, reachability: 'live', evidence: aggregate, browserVisible: true,
      inspectedAt: '2026-08-28T00:00:00Z' }).classification).toBe('aggregate-board');
    expect(classifyDestination({ listing: role, reachability: 'live', evidence: {
      ...aggregate, distinctJobLinkCount: 0, identicalEvidenceForDifferentPosting: true,
    }, browserVisible: true, inspectedAt: '2026-08-28T00:00:00Z' }).classification).toBe('aggregate-board');
  });

  it('keeps distinct valid paired-ID pages distinct', () => {
    const first = combineRenderedFrameEvidence({ role: 'Campus ASIC Engineer Intern', expectedPostingId: '7974837', frames: [
      frame({ url: 'https://www.jumptrading.com/hr/job?gh_jid=7974837', title: 'Campus ASIC Engineer Intern',
        visibleText: 'Campus ASIC Engineer Intern Bristol Job ID 7974837 Apply', applicationFormPresent: true }),
    ] })!;
    const second = combineRenderedFrameEvidence({ role: 'Campus Systems Engineer Intern', expectedPostingId: '8027952', frames: [
      frame({ url: 'https://www.jumptrading.com/hr/job?gh_jid=8027952', title: 'Campus Systems Engineer Intern',
        visibleText: 'Campus Systems Engineer Intern Singapore Job ID 8027952 Apply', applicationFormPresent: true }),
    ] })!;
    expect(first.renderedEvidenceHash).not.toBe(second.renderedEvidenceHash);
  });

  it('normalizes echoed IDs when comparing otherwise identical generic shells', () => {
    const first = combineRenderedFrameEvidence({ role: 'Software Engineering Intern', expectedPostingId: '1111111', frames: [
      frame({ url: 'https://careers.acme.test/openings?gh_jid=1111111', visibleText: 'Requested role 1111111 is unavailable. Browse all jobs.' }),
    ] })!;
    const second = combineRenderedFrameEvidence({ role: 'Software Engineering Intern', expectedPostingId: '2222222', frames: [
      frame({ url: 'https://careers.acme.test/openings?gh_jid=2222222', visibleText: 'Requested role 2222222 is unavailable. Browse all jobs.' }),
    ] })!;
    expect(first.renderedEvidenceHash).toBe(second.renderedEvidenceHash);
  });
});
