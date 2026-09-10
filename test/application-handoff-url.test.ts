import { describe, expect, it } from 'vitest';
import { createApiHandler } from '../src/api.js';
import { catalogGroupDetails, groupCatalogJobs } from '../src/catalog-groups.js';
import { publicApplicationUrl } from '../src/core/application-url.js';
import { renderPushTemplate, sendDigest, sendPendingNotifications, type PushMessage } from '../src/notifications.js';
import { MemoryInternshipStore, MemoryUserStore } from '../src/store.js';
import type { Internship, SourceOccurrence } from '../src/types.js';

const TRACKED_URL = 'https://job-boards.greenhouse.io/acme/jobs/4001?gh_jid=4001&utm_source=simplify&utm_medium=email&ref=github&source=github-feed&gh_src=abc123&fbclid=xyz';
const CLEAN_URL = 'https://job-boards.greenhouse.io/acme/jobs/4001?gh_jid=4001';

const occurrence: SourceOccurrence = {
  sourceId: 'simplify',
  document: 'simplify/2026-09-01',
  sourceUrl: TRACKED_URL,
  row: 1,
  company: 'Acme',
  title: 'Software Engineering Intern, Summer 2027',
  location: 'Remote',
  season: 'summer-2027',
  applyUrl: TRACKED_URL,
  compensation: { raw: '' },
  state: 'open',
};

const trackedJob: Internship = {
  jobId: 'tracked-job',
  company: 'Acme',
  title: 'Software Engineering Intern, Summer 2027',
  location: 'Remote',
  season: 'summer-2027',
  applyUrl: TRACKED_URL,
  normalizedUrl: CLEAN_URL,
  fingerprint: 'acme-4001',
  compensation: { raw: '' },
  sourceReferences: [occurrence],
  open: true,
  firstSeenAt: '2026-09-01T00:00:00.000Z',
  lastSeenAt: '2026-09-01T00:00:00.000Z',
  notification: { smsPending: false, digestPending: false },
};

describe('public application handoff URL', () => {
  it('removes reviewed tracking parameters case-insensitively, including repeats and utm_ families', () => {
    expect(publicApplicationUrl('https://jobs.example.test/role/7?UTM_Source=simplify&Ref=github&utm_anything=1&gh_jid=7'))
      .toBe('https://jobs.example.test/role/7?gh_jid=7');
    expect(publicApplicationUrl('https://jobs.example.test/role/7?utm_source=a&utm_source=b&ref=&gclid=z'))
      .toBe('https://jobs.example.test/role/7');
  });

  it('preserves posting-selecting and route-controlling parameters', () => {
    const mixed = 'https://jobs.example.test/apply?gh_jid=991&locale=en-US&embed=1&utm_campaign=spring';
    expect(publicApplicationUrl(mixed)).toBe('https://jobs.example.test/apply?gh_jid=991&locale=en-US&embed=1');
  });

  it('returns URLs without tracking parameters byte-for-byte and leaves unusable input alone', () => {
    expect(publicApplicationUrl('https://jobs.lever.co/acme/6f1a#apply')).toBe('https://jobs.lever.co/acme/6f1a#apply');
    expect(publicApplicationUrl('not a url')).toBe('not a url');
    expect(publicApplicationUrl('ftp://files.example.test/role?utm_source=x')).toBe('ftp://files.example.test/role?utm_source=x');
  });

  it('exposes the clean destination from jobs, groups, saved roles, and the apply handoff while keeping source provenance', async () => {
    const jobs = new MemoryInternshipStore();
    const users = new MemoryUserStore();
    await jobs.putInternship(trackedJob);
    const handler = createApiHandler({ jobs, users, now: () => '2026-09-02T00:00:00.000Z' });

    const job = JSON.parse((await handler({ rawPath: '/jobs/tracked-job', requestContext: { http: { method: 'GET' } } })).body);
    expect(job.applyUrl).toBe(CLEAN_URL);
    expect(job.sourceReferences[0].sourceUrl).toBe(TRACKED_URL);

    const list = JSON.parse((await handler({ rawPath: '/jobs', requestContext: { http: { method: 'GET' } } })).body);
    expect(list.jobs[0].applyUrl).toBe(CLEAN_URL);

    const [group] = groupCatalogJobs([trackedJob]);
    expect(group).toBeDefined();
    expect(catalogGroupDetails(group!).roles.map((role) => role.officialApplyUrl)).toEqual([CLEAN_URL]);

    const created = JSON.parse((await handler({
      rawPath: '/me/applications',
      body: JSON.stringify({ jobId: trackedJob.jobId }),
      requestContext: { http: { method: 'POST' }, authorizer: { jwt: { claims: { sub: 'student' } } } },
    })).body);
    expect(created.job.applyUrl).toBe(CLEAN_URL);
    expect(created.officialApplyUrl).toBe(CLEAN_URL);
  });

  it('sanitizes catalog groups served from a projection written before the change', async () => {
    const [built] = groupCatalogJobs([trackedJob]);
    const details = catalogGroupDetails(built!);
    const stale = { ...details, roles: details.roles.map((role) => ({ ...role, officialApplyUrl: TRACKED_URL })) };
    const jobs = new MemoryInternshipStore();
    await jobs.putCatalogProjection([stale], '2026-09-02T00:00:00.000Z');
    const handler = createApiHandler({ jobs, users: new MemoryUserStore(), now: () => '2026-09-02T00:00:00.000Z' });

    const response = JSON.parse((await handler({
      rawPath: `/catalog/groups/${encodeURIComponent(details.group.groupId)}`,
      requestContext: { http: { method: 'GET' } },
    })).body);
    expect(response.roles.map((role: { officialApplyUrl: string }) => role.officialApplyUrl)).toEqual([CLEAN_URL]);
  });

  it('opens clean destinations from push and digest notifications', async () => {
    expect(renderPushTemplate('{url}', trackedJob)).toBe(CLEAN_URL);

    const jobs = new MemoryInternshipStore();
    const published: PushMessage[] = [];
    await jobs.putInternship({ ...trackedJob, notification: { smsPending: true, digestPending: false } });
    await sendPendingNotifications(jobs, { publish: async (message) => { published.push(message); } });
    expect(published[0]?.click).toBe(CLEAN_URL);

    const digests: Array<{ text: string; html: string }> = [];
    const digestStore = new MemoryInternshipStore();
    await digestStore.putInternship({ ...trackedJob, notification: { smsPending: false, digestPending: true } });
    await sendDigest(digestStore, { send: async (_subject, text, html) => { digests.push({ text, html }); } });
    expect(digests[0]?.text).toContain(CLEAN_URL);
    expect(digests[0]?.html).toContain(CLEAN_URL);
    expect(digests[0]?.text).not.toContain('utm_source');
    expect(digests[0]?.html).not.toContain('utm_source');
  });
});
