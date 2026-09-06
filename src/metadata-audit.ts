import type { MetadataConflict, RoleMetadataEvidence } from './types.js';

export function encodeMetadataCursor(jobId: string, sourceId: string): string {
  return Buffer.from(`${jobId}\0${sourceId}`, 'utf8').toString('base64url');
}

export function decodeMetadataCursor(cursor: string | undefined): string {
  if (!cursor) return '';
  if (typeof cursor !== 'string' || cursor.length > 2048 || !/^[a-zA-Z0-9_-]+$/u.test(cursor)) throw new Error('Invalid metadata cursor');
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  if (!/^[^\0]+\0[^\0]+$/u.test(decoded) || Buffer.from(decoded).toString('base64url') !== cursor) throw new Error('Invalid metadata cursor');
  return decoded;
}

export const METADATA_AUDIT_FIELDS = ['compensation', 'education', 'graduation-window', 'locations', 'work-mode', 'application-deadline', 'employer-published-at', 'employer-updated-at'] as const;
export type MetadataAuditOutcome = 'extracted' | 'inspection-pending' | 'acquisition-failed' | 'incomplete-artifact' | 'no-disclosure-found' | 'ambiguous' | 'conflicting' | 'projection-missing';

/** Absence in parser output is never ground truth for employer non-disclosure.
 * no-disclosure-found is reserved for an independent field review. */
export function metadataFieldOutcomes(input: {
  evidence: readonly RoleMetadataEvidence[];
  conflicts?: readonly MetadataConflict[];
  acquired: boolean;
  complete: boolean;
  reviewedAbsent?: readonly string[];
}): Record<typeof METADATA_AUDIT_FIELDS[number], MetadataAuditOutcome> {
  return Object.fromEntries(METADATA_AUDIT_FIELDS.map((field) => {
    const found = input.evidence.some((item) => {
      switch (field) {
        case 'compensation': return !!item.compensationRanges?.length;
        case 'education': return !!item.education;
        case 'graduation-window': return !!item.education?.graduationDateWindow;
        case 'locations': return !!item.locations?.length;
        case 'work-mode': return !!item.workMode;
        case 'application-deadline': return !!item.applicationDeadline;
        case 'employer-published-at': return !!item.employerPublishedAt;
        case 'employer-updated-at': return !!item.employerUpdatedAt;
      }
    });
    const unknownPay = field === 'compensation' && input.evidence.some((item) => item.compensationRanges?.some((range) => range.period === 'unknown' || range.currency === 'XXX'));
    const outcome: MetadataAuditOutcome = input.conflicts?.some((conflict) => conflict.field === field) ? 'conflicting'
      : unknownPay ? 'ambiguous' : found ? 'extracted'
        : !input.acquired ? 'acquisition-failed' : !input.complete ? 'incomplete-artifact'
          : input.reviewedAbsent?.includes(field) ? 'no-disclosure-found' : 'inspection-pending';
    return [field, outcome];
  })) as Record<typeof METADATA_AUDIT_FIELDS[number], MetadataAuditOutcome>;
}

/** Fixed-cohort comparisons never silently drop removed/closed IDs. */
export function compareMetadataCohort(baseline: readonly { jobId: string; compensation?: { raw?: string } }[], current: readonly { jobId: string; compensation?: { raw?: string } }[]) {
  const currentById = new Map(current.map((job) => [job.jobId, job]));
  const cohort = baseline.map((before) => {
    const after = currentById.get(before.jobId);
    return { jobId: before.jobId, outcome: !after ? 'removed-or-closed' : after.compensation?.raw ? before.compensation?.raw ? 'retained-pay' : 'gained-pay' : before.compensation?.raw ? 'lost-pay' : 'still-no-pay' };
  });
  const counts: Record<string, number> = {};
  for (const row of cohort) counts[row.outcome] = (counts[row.outcome] ?? 0) + 1;
  return { denominator: baseline.length, counts, cohort };
}
