import { createHash } from 'node:crypto';
import { sourceRoleAgreement, type ApplicationPageEvidence } from './core/application-url.js';

export interface RenderedFrameSnapshot {
  url: string;
  parentUrl?: string;
  title?: string;
  description?: string;
  visibleText?: string;
  structuredJobText?: string;
  jobPostingCount: number;
  distinctJobLinkCount: number;
  applicationFormPresent: boolean;
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function normalizedFrameUrl(value: string, expectedPostingId?: string): string {
  try {
    const url = new URL(value);
    url.hash = '';
    if (expectedPostingId) {
      for (const [key, candidate] of [...url.searchParams.entries()]) {
        if (candidate.toLowerCase() === expectedPostingId.toLowerCase()) url.searchParams.delete(key);
      }
    }
    url.searchParams.sort();
    return url.toString();
  } catch {
    return value;
  }
}

function includesPostingId(value: string | undefined, expectedPostingId?: string): boolean | undefined {
  if (!expectedPostingId) return undefined;
  if (!value) return false;
  const escaped = expectedPostingId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, 'iu').test(value);
}

function withoutExpectedPostingId(value: string | undefined, expectedPostingId?: string): string | undefined {
  if (!value || !expectedPostingId) return value;
  const escaped = expectedPostingId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return value.replace(new RegExp(`(?:^|(?<=[^a-z0-9]))${escaped}(?=$|[^a-z0-9])`, 'giu'), '<posting-id>');
}

function frameEvidence(frame: RenderedFrameSnapshot, expectedPostingId?: string): ApplicationPageEvidence {
  const contentExcerpt = frame.visibleText?.replace(/\s+/gu, ' ').trim().slice(0, 12_000);
  const renderedPostingText = [contentExcerpt, frame.structuredJobText].filter(Boolean).join(' ');
  const postingIdPresent = includesPostingId(renderedPostingText, expectedPostingId);
  return {
    url: frame.url,
    ...(frame.title ? { title: frame.title } : {}),
    ...(frame.description ? { description: frame.description } : {}),
    ...(expectedPostingId ? { expectedPostingId } : {}),
    ...(postingIdPresent !== undefined ? { postingIdPresent } : {}),
    jobPostingCount: frame.jobPostingCount,
    distinctJobLinkCount: frame.distinctJobLinkCount,
    applicationFormPresent: frame.applicationFormPresent,
    ...(contentExcerpt ? { contentExcerpt, contentHash: hash(withoutExpectedPostingId(renderedPostingText, expectedPostingId)), contentSource: 'body' as const } : {}),
    confidence: { score: 100, level: 'high', recommendation: 'alert-eligible', signals: ['browser-visible evidence'] },
  };
}

function proofScore(role: string, evidence: ApplicationPageEvidence): number {
  const agreement = sourceRoleAgreement(role, evidence);
  return (agreement === 'strong' ? 8 : agreement === 'partial' ? 4 : 0)
    + (evidence.postingIdPresent ? 4 : 0)
    + (evidence.jobPostingCount === 1 ? 3 : 0)
    + (evidence.applicationFormPresent ? 2 : 0)
    + (evidence.contentExcerpt ? 1 : 0);
}

/**
 * Selects one rendered frame as the admission artifact. URLs, iframe attributes,
 * and hidden inputs never count as posting-ID proof; only visible text or a
 * single-role structured posting can carry the ID.
 */
export function combineRenderedFrameEvidence(input: {
  role: string;
  expectedPostingId?: string;
  frames: RenderedFrameSnapshot[];
  failedFrameCount?: number;
}): ApplicationPageEvidence | undefined {
  if (!input.frames.length) return undefined;
  const evaluated = input.frames.map((frame, index) => ({ frame, index, evidence: frameEvidence(frame, input.expectedPostingId) }));
  evaluated.sort((left, right) => proofScore(input.role, right.evidence) - proofScore(input.role, left.evidence)
    || (right.evidence.contentExcerpt?.length ?? 0) - (left.evidence.contentExcerpt?.length ?? 0));
  const selected = evaluated[0]!;
  const selfReferentialFrame = input.frames.some((frame) => frame.parentUrl
    && normalizedFrameUrl(frame.url, input.expectedPostingId) === normalizedFrameUrl(frame.parentUrl, input.expectedPostingId));
  const renderedEvidenceHash = hash(input.frames.map((frame) => {
    const evidence = frameEvidence(frame, input.expectedPostingId);
    return {
      url: normalizedFrameUrl(frame.url, input.expectedPostingId),
      contentHash: evidence.contentHash,
      title: withoutExpectedPostingId(evidence.title, input.expectedPostingId),
      postingIdPresent: evidence.postingIdPresent,
      jobPostingCount: evidence.jobPostingCount,
      distinctJobLinkCount: evidence.distinctJobLinkCount,
      applicationFormPresent: evidence.applicationFormPresent,
    };
  }).sort((left, right) => left.url.localeCompare(right.url)));
  return {
    ...selected.evidence,
    evidenceFrameUrl: selected.frame.url,
    evidenceFrameKind: selected.index === 0 ? 'main' : 'child',
    renderedFrameCount: input.frames.length,
    ...(input.failedFrameCount ? { failedFrameCount: input.failedFrameCount } : {}),
    ...(selfReferentialFrame ? { selfReferentialFrame: true } : {}),
    renderedEvidenceHash,
  };
}
