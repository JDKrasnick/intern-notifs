import type { Internship, PostingIdentity, PostingProvider } from './types.js';

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
  signals: Array<'employer' | 'title' | 'requisition-id' | 'provider-tenant' | 'provider'>;
  /** Additive evidence score; it is intentionally not presented as a probability. */
  confidenceScore: number;
}

export interface RecentClickedGmailRole {
  job: Internship;
  clickedAt: string;
  expiresAt: string;
}

export type GmailMatch =
  | { outcome: 'ignore'; reason: 'not-confirmation' | 'excluded-stage' | 'no-catalog-match' }
  | { outcome: 'review'; candidates: GmailDetectionCandidate[]; reasons: string[] }
  | { outcome: 'applied'; candidate: GmailDetectionCandidate; reasons: string[] };

const confirmationPhrases = [
  /application (?:has been |was )?(?:received|submitted)/iu,
  /received your (?:job )?application/iu,
  /\bsuccessfully submitted your\b.{0,160}\b(?:job )?application\b/iu,
  /thanks? for applying/iu,
  /thank you for (?:applying|your application)/iu,
  /we(?:'|’)ve received your application/iu,
  /your application to .+ is complete/iu,
  /solicitud (?:ha sido )?(?:recibida|enviada)/iu,
  /merci (?:d['’]avoir postulé|pour votre candidature)/iu,
  /bewerbung (?:ist )?(?:eingegangen|erhalten)/iu,
];

const recentConfirmationPhrases = [
  /\byour application (?:to|for)\b/iu,
  /\bthank you for your interest in\b/iu,
  /\bwe(?:'|’)ve got it\b.*\bapplication\b/iu,
  /\bapplication for .+ (?:is underway|is complete)\b/iu,
  /\bregarding .+\b(?:role|position)\b.+\bat\b/iu,
  /\bthanks? for wanting to (?:join|become)\b/iu,
];

const excludedPhrases = [
  /assessment|coding challenge|technical challenge|take[- ]home/iu,
  /interview|phone screen|screening call/iu,
  /offer|rejection|rejected|not moving forward|withdraw(?:al|n)?/iu,
  /\b(?:an )?update (?:from|on|regarding)\b/iu,
  /job alert|new jobs?|recommended jobs?|role alert/iu,
];

const providerDomains = /(?:greenhouse\.io|greenhouse-mail\.io|lever\.co|ashbyhq\.com)/iu;
const providerConfirmation = /application|candidature|bewerbung|solicitud/iu;
const providerReceipt = /received|submitted|applying|candidature|eingegangen|recibida|enviada/iu;
const noiseWords = new Set(['and', 'the', 'for', 'with', 'intern', 'internship', 'co-op', 'role', 'position', 'program', 'new', 'grad']);
const companySuffixes = new Set(['and', 'careers', 'co', 'company', 'corporation', 'corp', 'group', 'inc', 'incorporated', 'llc', 'limited', 'ltd', 'the']);
const confirmationWeights = { strong: 4, recent: 3, provider: 3 } as const;
const signalWeights: Record<GmailDetectionCandidate['signals'][number], number> = {
  employer: 4,
  title: 2,
  'requisition-id': 5,
  'provider-tenant': 3,
  provider: 1,
};
const autoApplyThreshold = 7;

function normalized(value: string): string {
  return value.normalize('NFKD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/[^a-z0-9]+/gu, ' ').trim();
}

function meaningfulWords(value: string): string[] {
  return normalized(value).split(' ').filter((word) => word.length >= 3 && !noiseWords.has(word));
}

function companyWords(value: string): string[] {
  return normalized(value).split(' ').filter((word) => word && !companySuffixes.has(word));
}

function senderDomain(sender: string): string | undefined {
  const match = sender.match(/@([^>\s]+)/u);
  return match?.[1]?.toLowerCase().replace(/[^a-z0-9.-]/gu, '');
}

function senderMatchesCompany(sender: string, company: string): boolean {
  const domain = senderDomain(sender);
  if (!domain) return false;
  const compactCompany = companyWords(company).join('');
  return compactCompany.length >= 3 && domain.split('.').some((label) => normalized(label).replace(/ /gu, '') === compactCompany);
}

function subjectUsesCompanyBrand(subject: string, company: string): boolean {
  const identityWords = companyWords(company);
  if (identityWords.length !== 1 || identityWords[0]!.length < 5) return false;
  return normalized(subject).split(' ').some((word) => word.startsWith(identityWords[0]!));
}

function senderProvider(sender: string): PostingProvider | undefined {
  const domain = senderDomain(sender) ?? '';
  if (/(?:^|\.)greenhouse-mail\.io$/u.test(domain) || /(?:^|\.)gh-mail\./u.test(domain)) return 'greenhouse';
  if (/(?:^|\.)hire\.lever\.co$/u.test(domain)) return 'lever';
  if (/(?:^|\.)ashbyhq\.com$/u.test(domain)) return 'ashby';
  if (/(?:^|\.)myworkday\.com$/u.test(domain)) return 'workday';
  if (/(?:^|\.)careers\.tiktok\.com$/u.test(domain)) return 'bytedance';
  return undefined;
}

function providerMatches(metadata: GmailMetadata, job: Internship): boolean {
  const provider = job.postingIdentity?.provider;
  const sender = senderProvider(metadata.sender);
  return Boolean(provider && provider !== 'unknown' && sender === provider);
}

function containsIdentity(text: string, value: string | undefined): boolean {
  if (!value) return false;
  const identity = normalized(value);
  if (identity.length < 3) return false;
  return ` ${normalized(text)} `.includes(` ${identity} `);
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

function candidate(metadata: GmailMetadata, job: Internship, receiptScore = 0, includeProvider = false): GmailDetectionCandidate | undefined {
  const text = `${metadata.sender} ${metadata.subject}`;
  const subject = normalized(metadata.subject);
  const textWords = new Set(normalized(text).split(' ').filter(Boolean));
  const subjectWords = new Set(subject.split(' ').filter(Boolean));
  const identityWords = companyWords(job.company);
  const titleWords = meaningfulWords(job.title);
  const company = (identityWords.length > 0 && identityWords.every((word) => textWords.has(word)))
    || senderMatchesCompany(metadata.sender, job.company)
    || subjectUsesCompanyBrand(metadata.subject, job.company);
  const distinctiveTitleWords = titleWords.filter((word) => word.length >= 4);
  const title = distinctiveTitleWords.length > 0
    && distinctiveTitleWords.filter((word) => subjectWords.has(word)).length >= Math.min(2, distinctiveTitleWords.length);
  const posting = postingSignals(job.postingIdentity, text);
  const signals: GmailDetectionCandidate['signals'] = [];
  if (company) signals.push('employer');
  if (title) signals.push('title');
  if (posting.requisition) signals.push('requisition-id');
  if (posting.tenant) signals.push('provider-tenant');
  if (includeProvider && providerMatches(metadata, job)) signals.push('provider');
  if (!signals.length) return undefined;
  const confidenceScore = receiptScore + signals.reduce((score, signal) => score + signalWeights[signal], 0);
  return { jobId: job.jobId, company: job.company, title: job.title, signals, confidenceScore };
}

function isExcluded(metadata: GmailMetadata): boolean {
  return excludedPhrases.some((phrase) => phrase.test(`${metadata.sender} ${metadata.subject}`));
}

function confirmationScore(metadata: GmailMetadata, recent: boolean): number {
  if (confirmationPhrases.some((phrase) => phrase.test(metadata.subject))) return confirmationWeights.strong;
  if (recent && recentConfirmationPhrases.some((phrase) => phrase.test(metadata.subject))) return confirmationWeights.recent;
  if (providerDomains.test(metadata.sender) && providerConfirmation.test(metadata.subject) && providerReceipt.test(metadata.subject)) return confirmationWeights.provider;
  return 0;
}

export function matchGmailApplication(metadata: GmailMetadata, catalog: Internship[]): GmailMatch {
  if (isExcluded(metadata)) return { outcome: 'ignore', reason: 'excluded-stage' };
  const receiptScore = confirmationScore(metadata, false);
  if (!receiptScore) return { outcome: 'ignore', reason: 'not-confirmation' };

  const candidates = catalog.map((job) => candidate(metadata, job, receiptScore)).filter((value): value is GmailDetectionCandidate => Boolean(value));
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

/** Match only roles for which this user recently opened the official application form. */
export function matchClickedGmailApplication(metadata: GmailMetadata, clickedRoles: Internship[]): GmailMatch {
  const result = matchGmailApplication(metadata, clickedRoles);
  if (result.outcome !== 'review' || result.candidates.length !== 1) return result;
  const only = result.candidates[0]!;
  if (!only.signals.some((signal) => signal === 'employer' || signal === 'provider-tenant' || signal === 'requisition-id')) return result;
  return {
    outcome: 'applied',
    candidate: only,
    reasons: [`The confirmation uniquely matches the role whose application form was opened (${only.signals.join(' + ')}).`],
  };
}

/**
 * Match only roles whose Apply window contains this message. This deliberately
 * permits broader receipt language and provider evidence than a mailbox-wide
 * scan because the user action supplies both the role scope and time boundary.
 */
export function matchRecentClickedGmailApplication(metadata: GmailMetadata, clickedRoles: RecentClickedGmailRole[]): GmailMatch {
  const receivedAt = Date.parse(metadata.receivedAt);
  if (!Number.isFinite(receivedAt)) return { outcome: 'ignore', reason: 'no-catalog-match' };
  const eligible = clickedRoles.filter(({ clickedAt, expiresAt }) => {
    const clicked = Date.parse(clickedAt); const expires = Date.parse(expiresAt);
    return Number.isFinite(clicked) && Number.isFinite(expires) && receivedAt >= clicked && receivedAt <= expires;
  });
  if (!eligible.length) return { outcome: 'ignore', reason: 'no-catalog-match' };
  if (isExcluded(metadata)) return { outcome: 'ignore', reason: 'excluded-stage' };
  const receiptScore = confirmationScore(metadata, true);
  if (!receiptScore) return { outcome: 'ignore', reason: 'not-confirmation' };

  const candidates = eligible.map(({ job }) => candidate(metadata, job, receiptScore, true))
    .filter((value): value is GmailDetectionCandidate => Boolean(value));
  if (!candidates.length) return { outcome: 'ignore', reason: 'no-catalog-match' };
  if (candidates.length > 1) return {
    outcome: 'review',
    candidates: candidates.slice(0, 10),
    reasons: ['More than one recent Apply click matches this confirmation.'],
  };
  const only = candidates[0]!;
  if (only.confidenceScore < autoApplyThreshold) {
    return { outcome: 'review', candidates, reasons: [`The evidence score is ${only.confidenceScore}/${autoApplyThreshold}; weak title or shared-provider evidence cannot confirm the role.`] };
  }
  return {
    outcome: 'applied',
    candidate: only,
    reasons: [`The confirmation falls inside one Apply window and scores ${only.confidenceScore}/${autoApplyThreshold} from ${only.signals.join(' + ')} evidence.`],
  };
}
