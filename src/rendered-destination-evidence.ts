import { createHash } from 'node:crypto';
import { explicitDestinationClosure, sourceRoleAgreement, type ApplicationPageEvidence } from './core/application-url.js';
import { applicationMetadataArtifactsFromJsonDocuments } from './role-metadata.js';

export interface RenderedFrameSnapshot {
  url: string;
  parentUrl?: string;
  title?: string;
  description?: string;
  visibleText?: string;
  structuredJobText?: string;
  validThrough?: string;
  structuredJobDocuments?: string[];
  compensationRows?: string[];
  jobPostingCount: number;
  distinctJobLinkCount: number;
  applicationFormPresent: boolean;
  inspectionTruncated?: boolean;
  loadingShell?: boolean;
}

/** Serializable into the browser frame; optional text permits pure regressions. */
export function renderedDescriptionReady(title: string, text = document.body?.innerText ?? ''): boolean {
  const terms = title.toLowerCase().split(/[^a-z0-9]+/u).filter((term) => term.length > 3);
  return /no longer available|job (?:not found|has expired)|position (?:has been filled|is closed)|under maintenance|sign in to continue/iu.test(text)
    || (text.length > 500 && terms.length > 0 && terms.filter((term) => text.toLowerCase().includes(term)).length >= Math.ceil(terms.length / 2));
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

/** Only an observed same-origin link with the exact immutable path ID is a
 * recovery candidate. Query-only directory links, title guesses and ambiguity
 * are intentionally rejected. The destination still needs normal verification. */
export function exactPostingRecoveryUrl(currentUrl: string, postingId: string | undefined, links: readonly string[]): string | undefined {
  if (!postingId) return undefined;
  try {
    const current = new URL(currentUrl);
    if (current.pathname.split('/').includes(postingId)) return undefined;
    const candidates = new Set(links.flatMap((value) => {
      try {
        const url = new URL(value, current);
        if (url.protocol !== 'https:' || url.origin !== current.origin || url.username || url.password
          || !url.pathname.split('/').some((part) => decodeURIComponent(part) === postingId)) return [];
        url.hash = ''; return [url.toString()];
      } catch { return []; }
    }));
    return candidates.size === 1 ? [...candidates][0] : undefined;
  } catch { return undefined; }
}

function withoutExpectedPostingId(value: string | undefined, expectedPostingId?: string): string | undefined {
  if (!value || !expectedPostingId) return value;
  const escaped = expectedPostingId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return value.replace(new RegExp(`(?:^|(?<=[^a-z0-9]))${escaped}(?=$|[^a-z0-9])`, 'giu'), '<posting-id>');
}

function frameEvidence(frame: RenderedFrameSnapshot, expectedPostingId?: string): ApplicationPageEvidence {
  const contentExcerpt = frame.visibleText?.split(/[\r\n]+/u).map(line => line.replace(/\s+/gu, ' ').trim()).filter(Boolean).join('\n').slice(0, 40_000);
  const renderedPostingText = [contentExcerpt, frame.structuredJobText].filter(Boolean).join(' ');
  const postingIdPresent = includesPostingId(renderedPostingText, expectedPostingId);
  const validThroughExpired = Boolean(frame.validThrough && Date.parse(frame.validThrough) <= Date.now());
  // Browser extraction has already selected the requested JobPosting record.
  // When it exists, arbitrary body text can include expired related-role cards
  // and must not become closure evidence for the selected posting.
  const closureArtifact = frame.structuredJobText ?? contentExcerpt;
  const explicitlyGone = [frame.title, frame.description, closureArtifact]
    .some((value) => explicitDestinationClosure(value ?? ''));
  const metadataArtifacts = applicationMetadataArtifactsFromJsonDocuments(frame.structuredJobDocuments ?? []);
  const compensationSections = (frame.compensationRows ?? []).slice(0, 20).flatMap((row) => {
    // Rows come only from a visible list under an explicit compensation heading.
    // Keep publisher labels verbatim rather than guessing geography or education.
    const match = /^([^$€£\d]{0,120}?)((?:(?:US|CA|AU|NZ|SG|HK)\$|[$€£]|[A-Z]{3}\s+)\s*\d[\s\S]*)$/u.exec(row.trim());
    return match ? [{ label: match[1]!.trim(), text: match[2]!.trim() }] : [];
  });
  return {
    url: frame.url,
    ...(frame.inspectionTruncated ? { inspectionTruncated: true } : {}),
    ...(frame.loadingShell ? { loadingShell: true } : {}),
    ...(frame.title ? { title: frame.title } : {}),
    ...(frame.description ? { description: frame.description } : {}),
    ...(expectedPostingId ? { expectedPostingId } : {}),
    ...(postingIdPresent !== undefined ? { postingIdPresent } : {}),
    jobPostingCount: frame.jobPostingCount,
    distinctJobLinkCount: frame.distinctJobLinkCount,
    applicationFormPresent: frame.applicationFormPresent,
    ...(frame.validThrough ? { validThrough: frame.validThrough } : {}),
    ...(validThroughExpired
      ? { closureState: 'gone' as const, closureSignal: 'valid-through-expired' as const }
      : explicitlyGone ? { closureState: 'gone' as const, closureSignal: 'explicit-language' as const }
        : { closureState: 'open' as const }),
    ...(contentExcerpt ? { contentExcerpt, contentHash: hash(withoutExpectedPostingId(renderedPostingText, expectedPostingId)), contentSource: 'body' as const } : {}),
    ...(metadataArtifacts.length ? { metadataArtifacts } : {}),
    ...(compensationSections.length ? { compensationSections } : {}),
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
  // Closure is authoritative only on the frame selected as the requested
  // posting artifact. Related/recommended role frames cannot close it.
  const closure = selected.evidence.closureState === 'gone' ? selected.evidence : undefined;
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
      closureState: evidence.closureState,
      closureSignal: evidence.closureSignal,
      validThrough: evidence.validThrough,
    };
  }).sort((left, right) => left.url.localeCompare(right.url)));
  return {
    ...selected.evidence,
    ...(closure ? { closureState: closure.closureState, closureSignal: closure.closureSignal,
      ...(closure.validThrough ? { validThrough: closure.validThrough } : {}) } : {}),
    evidenceFrameUrl: selected.frame.url,
    evidenceFrameKind: selected.index === 0 ? 'main' : 'child',
    renderedFrameCount: input.frames.length,
    ...(input.failedFrameCount ? { failedFrameCount: input.failedFrameCount } : {}),
    ...(selfReferentialFrame ? { selfReferentialFrame: true } : {}),
    renderedEvidenceHash,
  };
}
