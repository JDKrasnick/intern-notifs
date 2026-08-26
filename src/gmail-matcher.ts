import type { Internship, PostingIdentity } from './types.js';

export interface GmailMetadata {
  sender: string;
  subject: string;
  receivedAt: string;
  labels: string[];
}

export interface GmailDetectionCandidate {
  jobId: string;
  company: string;
  title: string;
  signals: Array<'employer' | 'title' | 'requisition-id' | 'provider-tenant'>;
}

export type GmailMatch =
  | { outcome: 'ignore'; reason: 'not-confirmation' | 'excluded-stage' | 'no-catalog-match' }
  | { outcome: 'review'; candidates: GmailDetectionCandidate[]; reasons: string[] }
  | { outcome: 'applied'; candidate: GmailDetectionCandidate; reasons: string[] };

const confirmationPhrases = [
  /application (?:has been |was )?(?:received|submitted)/iu,
  /received your application/iu,
  /thanks? for applying/iu,
  /thank you for (?:applying|your application)/iu,
  /we(?:'|’)ve received your application/iu,
  /your application to .+ is complete/iu,
  /solicitud (?:ha sido )?(?:recibida|enviada)/iu,
  /merci (?:d['’]avoir postulé|pour votre candidature)/iu,
  /bewerbung (?:ist )?(?:eingegangen|erhalten)/iu,
];

const excludedPhrases = [
  /assessment|coding challenge|technical challenge|take[- ]home/iu,
  /interview|phone screen|screening call/iu,
  /offer|rejection|rejected|not moving forward|withdraw(?:al|n)?/iu,
  /job alert|new jobs?|recommended jobs?|role alert/iu,
];

const providerDomains = /(?:greenhouse\.io|greenhouse-mail\.io|lever\.co|ashbyhq\.com)/iu;
const providerConfirmation = /application|candidature|bewerbung|solicitud/iu;
const providerReceipt = /received|submitted|applying|candidature|eingegangen|recibida|enviada/iu;
const noiseWords = new Set(['and', 'the', 'for', 'with', 'intern', 'internship', 'co-op', 'role', 'position', 'program', 'new', 'grad']);

function normalized(value: string): string {
  return value.normalize('NFKD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/[^a-z0-9]+/gu, ' ').trim();
}

function meaningfulWords(value: string): string[] {
  return normalized(value).split(' ').filter((word) => word.length >= 3 && !noiseWords.has(word));
}

function containsIdentity(text: string, value: string | undefined): boolean {
  if (!value) return false;
  const identity = normalized(value);
  return identity.length >= 3 && normalized(text).includes(identity);
}

function postingSignals(identity: PostingIdentity | undefined, text: string) {
  if (!identity) return { requisition: false, tenant: false };
  const ids = [identity.providerPostingId, identity.employerRequisitionId, ...identity.aliases
    .filter((alias) => alias.kind === 'provider-posting' || alias.kind === 'employer-requisition')
    .map((alias) => alias.value)];
  return {
    requisition: ids.some((id) => containsIdentity(text, id)),
    tenant: containsIdentity(text, identity.tenant),
  };
}

function candidate(metadata: GmailMetadata, job: Internship): GmailDetectionCandidate | undefined {
  const text = `${metadata.sender} ${metadata.subject}`;
  const subject = normalized(metadata.subject);
  const companyWords = meaningfulWords(job.company);
  const titleWords = meaningfulWords(job.title);
  const company = companyWords.length > 0 && companyWords.every((word) => normalized(text).includes(word));
  const distinctiveTitleWords = titleWords.filter((word) => word.length >= 4);
  const title = distinctiveTitleWords.length > 0
    && distinctiveTitleWords.filter((word) => subject.includes(word)).length >= Math.min(2, distinctiveTitleWords.length);
  const posting = postingSignals(job.postingIdentity, text);
  const signals: GmailDetectionCandidate['signals'] = [];
  if (company) signals.push('employer');
  if (title) signals.push('title');
  if (posting.requisition) signals.push('requisition-id');
  if (posting.tenant) signals.push('provider-tenant');
  if (!signals.length) return undefined;
  return { jobId: job.jobId, company: job.company, title: job.title, signals };
}

export function matchGmailApplication(metadata: GmailMetadata, catalog: Internship[]): GmailMatch {
  const text = `${metadata.sender} ${metadata.subject}`;
  if (excludedPhrases.some((phrase) => phrase.test(text))) return { outcome: 'ignore', reason: 'excluded-stage' };
  const confirmed = confirmationPhrases.some((phrase) => phrase.test(metadata.subject))
    || (providerDomains.test(metadata.sender) && providerConfirmation.test(metadata.subject) && providerReceipt.test(metadata.subject));
  if (!confirmed) return { outcome: 'ignore', reason: 'not-confirmation' };

  const candidates = catalog.map((job) => candidate(metadata, job)).filter((value): value is GmailDetectionCandidate => Boolean(value));
  if (!candidates.length) return { outcome: 'ignore', reason: 'no-catalog-match' };
  const highConfidence = candidates.filter((value) => value.signals.length >= 2
    && (value.signals.includes('title') || value.signals.includes('requisition-id')));
  if (highConfidence.length === 1 && candidates.length === 1) {
    return {
      outcome: 'applied',
      candidate: highConfidence[0]!,
      reasons: [`Confirmation phrase and ${highConfidence[0]!.signals.join(' + ')} uniquely identify this catalog role.`],
    };
  }
  return {
    outcome: 'review',
    candidates: candidates.slice(0, 10),
    reasons: [highConfidence.length > 1 ? 'More than one catalog role has strong identity evidence.' : 'The confirmation does not uniquely provide two role identity signals.'],
  };
}
