import { describe, expect, it } from 'vitest';
import { verifySourceQuality } from '../src/sources/quality.js';
import type { RawListing } from '../src/types.js';

function row(applyUrl: string, row = 1): RawListing {
  return { sourceId: 'fixture', document: 'roles', sourceUrl: 'https://source.example/roles', row, company: 'Acme', title: 'Software Engineering Intern', location: 'Remote', season: 'summer-2027', applyUrl, compensation: { raw: '' }, state: 'open', fetchedAt: '2026-07-20T00:00:00.000Z' };
}
function quality(policy: Parameters<typeof verifySourceQuality>[0][number]['policy'], listings: RawListing[], previous?: { sourceId: string; successfulFetches: number; lastRowCount?: number }) {
  return verifySourceQuality([{ policy, result: { sourceId: policy.id, listings, notModified: false }, previous }]);
}

describe('source-quality policy', () => {
  it('rejects aggregator and non-HTTPS application URLs', () => {
    const report = quality({ id: 'fixture', sourceClass: 'curated', minimumDistinctApplicationHosts: 1, maximumApplicationHostShare: 1 }, [row('http://linkedin.com/jobs/1'), row('https://indeed.com/viewjob?jk=1', 2)]);
    expect(report.sources[0]?.rejectedUrls).toHaveLength(2);
    expect(report.failures.join(' ')).toContain('HTTPS');
    expect(report.failures.join(' ')).toContain('aggregator-only');
  });
  it('requires a direct configured Lever apply path', () => {
    const report = quality({ id: 'lever-acme', sourceClass: 'lever', leverSite: 'acme' }, [row('https://jobs.lever.co/wrong/abc/apply'), row('https://jobs.lever.co/acme/abc')]);
    expect(report.failures).toHaveLength(2);
    expect(report.failures[0]).toContain('jobs.lever.co/acme/<posting>/apply');
  });
  it('flags unannounced zero-row drift but allows a dormant source', () => {
    const previous = { sourceId: 'fixture', successfulFetches: 2, lastRowCount: 12 };
    expect(quality({ id: 'fixture', sourceClass: 'curated' }, [], previous).failures.join(' ')).toContain('suspicious zero-row');
    expect(quality({ id: 'fixture', sourceClass: 'curated', dormant: true }, [], previous).failures).toEqual([]);
  });
  it('requires curated URL diversity and limits host concentration', () => {
    const report = quality({ id: 'fixture', sourceClass: 'curated' }, [row('https://jobs.example.test/1'), row('https://jobs.example.test/2', 2)]);
    expect(report.failures.join(' ')).toContain('requires 2');
    expect(report.failures.join(' ')).toContain('concentration');
  });
  it('reports row counts, open-role counts, and host distribution', () => {
    const report = quality({ id: 'fixture', sourceClass: 'curated', minimumDistinctApplicationHosts: 1, maximumApplicationHostShare: 1 }, [row('https://jobs.example.test/1')]);
    expect(report.sources[0]).toMatchObject({ rowCount: 1, openRoleCount: 1, hostDistribution: { 'jobs.example.test': 1 }, rejectedUrls: [] });
  });
  it('keeps pre-publication URL rejections in the report without treating withheld rows as a parser failure', () => {
    const report = verifySourceQuality([{
      policy: { id: 'fixture', sourceClass: 'curated', minimumDistinctApplicationHosts: 1, maximumApplicationHostShare: 1 },
      result: { sourceId: 'fixture', listings: [row('https://jobs.example.test/1')], notModified: false, rejectedApplicationUrls: [{ row: 2, url: 'https://indeed.com/job/2', reason: 'aggregator-only host is not allowed (indeed.com)' }] }
    }]);
    expect(report.sources[0]?.rejectedUrls).toHaveLength(1);
    expect(report.failures).toEqual([]);
  });
});
