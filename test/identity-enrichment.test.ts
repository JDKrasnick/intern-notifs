import { describe, expect, it } from 'vitest';
import {
  buildInternshipIdentity,
  educationAudienceLabel,
  educationAudienceMatches,
  deriveTitleFields,
  mergeEducationEvidence,
  mergeProvenancedValues,
} from '../src/identity/enrichment.js';
import type { FieldProvenance } from '../src/types.js';

const evidence = (source: FieldProvenance['source'], evidenceCode: string): FieldProvenance => ({
  source,
  sourceId: source,
  evidenceCode,
});

describe('provider-neutral field enrichment', () => {
  it('builds a durable grouping identity from one official ATS posting', () => {
    const identity = buildInternshipIdentity({
      sourceId: 'greenhouse-acme',
      sourceUrl: 'https://boards.greenhouse.io/acme/jobs/42',
      observedAt: '2026-08-24T00:00:00.000Z',
      company: 'Acme, Inc.',
      title: 'Software Engineering Intern, Summer 2027',
      location: 'New York, NY / Remote',
      season: 'summer-2027',
      seasonEvidenceStatus: 'explicit',
      content: "Currently enrolled in a bachelor's or master's program.",
      workMode: 'hybrid',
    });
    expect(identity).toMatchObject({
      company: { canonicalId: 'acme' },
      programType: { value: 'internship' },
      season: { term: 'summer', year: 2027, evidenceStatus: 'explicit' },
      education: { levels: ['masters', 'undergraduate'], evidenceStatus: 'explicit' },
      locations: [{ name: 'New York, NY', workMode: 'hybrid' }, { name: 'Remote', workMode: 'hybrid' }],
    });
  });

  it('prefers official structured evidence and retains corroboration for the winning value', () => {
    expect(mergeProvenancedValues([
      { value: 'Engineer Intern', provenance: [evidence('reviewed-community', 'table-title')] },
      { value: 'Software Engineer Intern', provenance: [evidence('official-page', 'h1')] },
      { value: 'Software Engineer Intern', provenance: [evidence('official-ats', 'job-title')] },
    ])).toEqual({
      value: 'Software Engineer Intern',
      provenance: [evidence('official-ats', 'job-title'), evidence('official-page', 'h1')],
    });
  });

  it('keeps missing education unspecified, visible, and matching every user', () => {
    const audience = mergeEducationEvidence([{ provenance: [evidence('official-ats', 'education-absent')] }]);
    expect(audience).toMatchObject({ levels: [], evidenceStatus: 'unspecified' });
    expect(educationAudienceMatches(audience, ['undergraduate'])).toBe(true);
    expect(educationAudienceLabel(audience)).toBe('Education level not specified by employer.');
  });

  it('unions compatible explicit audiences while keeping minimum degree separate', () => {
    const audience = mergeEducationEvidence([
      { levels: ['undergraduate'], minimumDegree: 'high-school', provenance: [evidence('official-ats', 'audience')] },
      { levels: ['masters'], minimumDegree: 'high-school', provenance: [evidence('official-page', 'requirements')] },
    ]);
    expect(audience).toMatchObject({
      levels: ['masters', 'undergraduate'],
      minimumDegree: 'high-school',
      evidenceStatus: 'explicit',
    });
    expect(educationAudienceMatches(audience, ['doctoral'])).toBe(false);
  });

  it('marks contradictory degree requirements and disjoint graduation windows as conflicting', () => {
    const audience = mergeEducationEvidence([
      {
        levels: ['undergraduate'],
        minimumDegree: 'bachelors',
        graduationDateWindow: { end: '2027-05' },
        provenance: [evidence('official-json-ld', 'qualification')],
      },
      {
        levels: ['undergraduate'],
        minimumDegree: 'masters',
        graduationDateWindow: { start: '2028-01' },
        provenance: [evidence('official-page', 'requirements')],
      },
    ]);
    expect(audience.evidenceStatus).toBe('conflicting');
    expect(audience.minimumDegree).toBeUndefined();
    expect(educationAudienceMatches(audience, ['doctoral'])).toBe(true);
  });

  it('preserves the official title while deriving a lightly cleaned display title and supplemental tags', () => {
    const provenance = evidence('deterministic-inference', 'title-v1');
    expect(deriveTitleFields({
      value: '🔥  Machine Learning / Software Engineer Internship ',
      provenance: [evidence('official-ats', 'job-title')],
    }, provenance)).toEqual({
      official: {
        value: '🔥  Machine Learning / Software Engineer Internship ',
        provenance: [evidence('official-ats', 'job-title')],
      },
      display: { value: 'Machine Learning / Software Engineer Internship', provenance: [provenance] },
      search: { value: 'machine learning software engineer intern', provenance: [provenance] },
      disciplines: [
        { value: 'ai-ml', provenance: [provenance] },
        { value: 'software', provenance: [provenance] },
      ],
    });
  });
});
