import { describe, expect, it } from 'vitest';
import { buildNotificationLog, canonicalNotificationUrl } from '../src/notification-log.js';
import type { DeliveryReceipt, Internship } from '../src/types.js';

function job(jobId: string, normalizedUrl: string, title = 'Software Engineer Intern'): Internship {
  return { jobId, company: 'TikTok', title, location: 'Seattle, WA', season: '2027', applyUrl: normalizedUrl, normalizedUrl, fingerprint: jobId, compensation: { raw: '' }, sourceReferences: [{ sourceId: 'feed', document: 'README', sourceUrl: 'https://feed.example.test', row: 1, company: 'TikTok', title, location: 'Seattle, WA', season: '2027', applyUrl: normalizedUrl, compensation: { raw: '' }, state: 'open' }], open: true, firstSeenAt: '2026-08-11T00:00:00.000Z', lastSeenAt: '2026-08-11T00:00:00.000Z', notification: { smsPending: false, digestPending: false } };
}
function receipt(jobId: string, createdAt: string): DeliveryReceipt { return { userId: 'private-user', token: 'private-token', jobId, status: 'ok', createdAt, updatedAt: createdAt }; }

describe('notification log', () => {
  it('canonicalizes provider URL variants and reports repeated rendered titles without recipient data', () => {
    expect(canonicalNotificationUrl('https://jobs.ashbyhq.com/acme/501d374d-7d4f-4889-bc53-0a1fd16253ea/application?embed=true')).toBe('https://jobs.ashbyhq.com/acme/501d374d-7d4f-4889-bc53-0a1fd16253ea');
    const report = buildNotificationLog(
      [receipt('a', '2026-08-11T01:00:00.000Z'), receipt('b', '2026-08-11T02:00:00.000Z')],
      [job('a', 'https://jobs.ashbyhq.com/acme/501d374d-7d4f-4889-bc53-0a1fd16253ea'), job('b', 'https://jobs.ashbyhq.com/acme/501d374d-7d4f-4889-bc53-0a1fd16253ea/application?embed=true')],
    );
    expect(report.summary).toMatchObject({ matched: 2, byStatus: { ok: 2 } });
    expect(report.duplicateApplications).toHaveLength(1);
    expect(report.repeatedRoleFamilies).toHaveLength(1);
    expect(report.repeatedRenderedTitles).toHaveLength(1);
    expect(JSON.stringify(report)).not.toContain('private-user');
    expect(JSON.stringify(report)).not.toContain('private-token');
  });
});
