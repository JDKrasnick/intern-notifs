import { createHash } from 'node:crypto';
import { inferJobFocuses, matchesJobFilter, type JobFilter } from './core/filters.js';
import type { Internship } from './types.js';

export const DEFAULT_RELEASE_WINDOW_SECONDS = 8;
export const MAX_RELEASE_WINDOW_SECONDS = 10;

export type NotificationChannel = 'push' | 'email';
export type DeliveryState = 'claimed' | 'accepted' | 'delivered' | 'definitive-failure' | 'unknown';
export type ReleasePresentation = 'individual' | 'program-group' | 'employer-release';

export interface CandidateRelease {
  releaseId: string;
  employerId: string;
  company: string;
  openedAt: string;
  flushAt: string;
  jobIds: string[];
  jobs: Internship[];
}

export interface PersonalizedRelease {
  releaseId: string;
  userId: string;
  presentation: ReleasePresentation;
  jobs: Internship[];
  newlyMatchedJobIds: string[];
  season: string;
  education: string;
  disciplines: string[];
}

export interface NotificationIntent {
  intentId: string;
  release: PersonalizedRelease;
  channel: NotificationChannel;
  eligibleAt: string;
}

export interface DeliveryClaim {
  claimId: string;
  tombstoneId: string;
  userId: string;
  channel: NotificationChannel;
  destinationId: string;
  releaseId: string;
  jobIds: string[];
  state: DeliveryState;
  createdAt: string;
  updatedAt: string;
  providerId?: string;
  diagnosticExpiresAt?: string;
}

function stableHash(parts: string[]) {
  return createHash('sha256').update(parts.join('\0')).digest('hex');
}

function normalizedEmployer(company: string) {
  return company.normalize('NFKC').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'unknown';
}

function exactJobId(job: Internship): string {
  const identity = (job as Internship & { postingIdentity?: { canonicalJobId?: string } }).postingIdentity;
  return identity?.canonicalJobId ?? job.jobId;
}

export function validateReleaseWindow(seconds: number) {
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > MAX_RELEASE_WINDOW_SECONDS) {
    throw new Error(`Release window must be an integer from 1 to ${MAX_RELEASE_WINDOW_SECONDS} seconds`);
  }
  return seconds;
}

/** A release is immutable: a later candidate creates a new release and can only contain its new job set. */
export function createCandidateRelease(jobs: Internship[], openedAt: Date, windowSeconds = DEFAULT_RELEASE_WINDOW_SECONDS): CandidateRelease {
  validateReleaseWindow(windowSeconds);
  if (!jobs.length) throw new Error('A candidate release requires at least one job');
  const company = jobs[0]!.company;
  const employerId = normalizedEmployer(company);
  if (jobs.some((job) => normalizedEmployer(job.company) !== employerId)) throw new Error('A candidate release cannot span employers');
  const unique = [...new Map(jobs.map((job) => [exactJobId(job), job])).entries()].sort(([left], [right]) => left.localeCompare(right));
  const opened = openedAt.toISOString();
  const flushAt = new Date(openedAt.getTime() + windowSeconds * 1_000).toISOString();
  const releaseId = stableHash(['release-v1', employerId, opened, ...unique.map(([id]) => id)]);
  return { releaseId, employerId, company, openedAt: opened, flushAt, jobIds: unique.map(([id]) => id), jobs: unique.map(([, job]) => job) };
}

function educationLabel(job: Internship): string {
  const identity = (job as Internship & { internshipIdentity?: { education?: { audience?: string[]; evidence?: string } } }).internshipIdentity;
  const audience = identity?.education?.audience?.filter(Boolean) ?? [];
  if (!audience.length || identity?.education?.evidence === 'unspecified') return 'Education level not specified by employer';
  return audience.join(' + ');
}

function seasonLabel(job: Internship) {
  const value = job.season.trim();
  return value || 'Season not specified';
}

function cohortKey(job: Internship) {
  return `${seasonLabel(job)}\0${educationLabel(job)}`;
}

function personalized(release: CandidateRelease, userId: string, jobs: Internship[], presentation: ReleasePresentation): PersonalizedRelease {
  const seasons = [...new Set(jobs.map(seasonLabel))];
  const education = [...new Set(jobs.map(educationLabel))];
  const disciplines = [...new Set(jobs.flatMap(inferJobFocuses))].slice(0, 4);
  return {
    releaseId: release.releaseId,
    userId,
    presentation,
    jobs,
    newlyMatchedJobIds: jobs.map(exactJobId).sort(),
    season: seasons.length === 1 ? seasons[0]! : 'Multiple seasons',
    education: education.join(' + '),
    disciplines,
  };
}

/** Filtering happens before grouping so counts and summaries never expose nonmatching roles. */
export function personalizeRelease(release: CandidateRelease, userId: string, filter?: JobFilter): PersonalizedRelease[] {
  const matching = release.jobs.filter((job) => matchesJobFilter(job, filter));
  if (!matching.length) return [];
  if (matching.length >= 4) return [personalized(release, userId, matching, 'employer-release')];
  const cohorts = new Map<string, Internship[]>();
  for (const job of matching) cohorts.set(cohortKey(job), [...(cohorts.get(cohortKey(job)) ?? []), job]);
  return [...cohorts.values()].map((jobs) => personalized(release, userId, jobs, jobs.length === 1 ? 'individual' : 'program-group'));
}

function localClock(at: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return Number(value.hour) * 60 + Number(value.minute);
}

function parseClock(value: string) {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new Error(`Invalid quiet-hours clock: ${value}`);
  const [hour, minute] = value.split(':').map(Number);
  return hour! * 60 + minute!;
}

export function isQuietTime(at: Date, quietHours?: { start: string; end: string; timezone: string }) {
  if (!quietHours || quietHours.start === quietHours.end) return false;
  const clock = localClock(at, quietHours.timezone);
  const start = parseClock(quietHours.start);
  const end = parseClock(quietHours.end);
  return start < end ? clock >= start && clock < end : clock >= start || clock < end;
}

/** Minute stepping is deliberate: it remains correct across DST gaps and repeated local times. */
export function nextNotificationEligibility(at: Date, quietHours?: { start: string; end: string; timezone: string }) {
  if (!isQuietTime(at, quietHours)) return at.toISOString();
  for (let offset = 1; offset <= 60 * 48; offset += 1) {
    const candidate = new Date(at.getTime() + offset * 60_000);
    if (!isQuietTime(candidate, quietHours)) return candidate.toISOString();
  }
  throw new Error('Could not resolve quiet-hours end within 48 hours');
}

export function logicalTombstoneId(userId: string, channel: NotificationChannel, releaseId: string, jobIds: string[]) {
  return stableHash(['logical-delivery-v1', userId, channel, releaseId, ...[...new Set(jobIds)].sort()]);
}

export function deliveryClaimId(tombstoneId: string, destinationId: string) {
  return stableHash(['delivery-destination-v1', tombstoneId, destinationId]);
}

export class MemoryDeliveryClaimStore {
  private readonly claims = new Map<string, DeliveryClaim>();
  private readonly tombstones = new Set<string>();

  claim(input: Omit<DeliveryClaim, 'claimId' | 'tombstoneId' | 'state' | 'createdAt' | 'updatedAt'>, at: Date): DeliveryClaim | undefined {
    const tombstoneId = logicalTombstoneId(input.userId, input.channel, input.releaseId, input.jobIds);
    const claimId = deliveryClaimId(tombstoneId, input.destinationId);
    if (this.claims.has(claimId)) return undefined;
    // A tombstone blocks a repeated logical email. Push remains destination-specific
    // so every active device gets exactly one delivery.
    if (input.channel === 'email' && this.tombstones.has(tombstoneId)) return undefined;
    const now = at.toISOString();
    const claim: DeliveryClaim = { ...input, jobIds: [...new Set(input.jobIds)].sort(), claimId, tombstoneId, state: 'claimed', createdAt: now, updatedAt: now };
    this.claims.set(claimId, claim);
    this.tombstones.add(tombstoneId);
    return structuredClone(claim);
  }

  transition(claimId: string, state: DeliveryState, at: Date, providerId?: string): DeliveryClaim {
    const current = this.claims.get(claimId);
    if (!current) throw new Error('Delivery claim not found');
    const allowed: Record<DeliveryState, DeliveryState[]> = {
      claimed: ['accepted', 'definitive-failure', 'unknown'],
      accepted: ['delivered', 'definitive-failure', 'unknown'],
      delivered: [],
      'definitive-failure': [],
      unknown: [],
    };
    if (!allowed[current.state].includes(state)) throw new Error(`Invalid delivery transition ${current.state} -> ${state}`);
    const updated = { ...current, state, updatedAt: at.toISOString(), ...(providerId ? { providerId } : {}) };
    this.claims.set(claimId, updated);
    return structuredClone(updated);
  }

  get(claimId: string) { const value = this.claims.get(claimId); return value ? structuredClone(value) : undefined; }
}

export function naturalTruncate(value: string, maxLength: number) {
  const clean = value.replace(/\s+/g, ' ').trim();
  if (clean.length <= maxLength) return clean;
  const shortened = clean.slice(0, Math.max(1, maxLength - 1));
  const boundary = shortened.lastIndexOf(' ');
  return `${shortened.slice(0, boundary >= Math.floor(maxLength * 0.6) ? boundary : shortened.length).trimEnd()}…`;
}

export function renderReleasePush(release: PersonalizedRelease) {
  const first = release.jobs[0]!;
  if (release.presentation === 'individual') {
    return { title: naturalTruncate(first.title, 120), body: `${first.company} · ${release.season} · ${release.education}`, data: { destination: 'release', releaseId: release.releaseId, url: `internnotifs://releases/${release.releaseId}` } } as const;
  }
  return {
    title: `${first.company} posted ${release.jobs.length} matching roles`,
    body: [release.disciplines.join(', '), release.season, release.education].filter(Boolean).join(' · '),
    data: { destination: 'release', releaseId: release.releaseId, url: `internnotifs://releases/${release.releaseId}` },
  } as const;
}

export function renderReleaseEmail(release: PersonalizedRelease) {
  const rows = release.jobs.map((job) => `${job.title}\n${job.company} · ${job.location} · ${seasonLabel(job)} · ${educationLabel(job)}\nInternNotifs: internnotifs://releases/${release.releaseId}\nOfficial application: ${job.applyUrl}`);
  return { subject: `${release.jobs[0]!.company} posted ${release.jobs.length} matching role${release.jobs.length === 1 ? '' : 's'}`, text: rows.join('\n\n') };
}

export function createNotificationIntents(release: CandidateRelease, userId: string, filter: JobFilter | undefined, channels: NotificationChannel[], at: Date, quietHours?: { start: string; end: string; timezone: string }): NotificationIntent[] {
  const eligibleAt = nextNotificationEligibility(at, quietHours);
  return personalizeRelease(release, userId, filter).flatMap((personalizedRelease) => channels.map((channel) => ({
    intentId: stableHash(['intent-v1', personalizedRelease.releaseId, userId, channel, ...personalizedRelease.newlyMatchedJobIds]),
    release: personalizedRelease,
    channel,
    eligibleAt,
  })));
}
