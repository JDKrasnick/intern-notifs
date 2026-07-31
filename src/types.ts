import type { JobFilter } from './core/filters.js';
import type { EmployerCategory } from './core/employers.js';

export type ApplicationStatus =
  | 'saved' | 'applied' | 'assessment' | 'interview' | 'offer' | 'rejected' | 'withdrawn';

export interface ApplicationRecord {
  applicationId: string;
  jobId: string;
  status: ApplicationStatus;
  updatedAt: string;
  createdAt: string;
  notes?: string;
  /** `partner` is only set after an employer has granted direct-submit access. */
  applyMode?: 'official-form' | 'partner';
}

export type AlertDelivery = 'immediate' | 'daily-digest';

/** Delivery preferences are stored separately from the role filter so they can evolve independently. */
export interface AlertSettings {
  delivery: AlertDelivery;
  quietHours?: { start: string; end: string; timezone: string };
  applicationReminders: boolean;
  followUpDays: number;
}

export interface UserPreferences {
  userId: string;
  filter: JobFilter;
  alertsEnabled: boolean;
  onboardingComplete: boolean;
  /**
   * The bounded timestamp used by the signed-in launch inbox. A missing value
   * means this is the user's first launch after the feature was introduced.
   */
  lastCatalogOpenedAt?: string;
  alertSettings?: AlertSettings;
  /** Uses the same safe placeholders as the legacy compact ntfy notification. */
  push?: { titleTemplate?: string; descriptionTemplate?: string; roleAbbreviations?: Record<string, string> };
  updatedAt: string;
}

export interface DeviceToken {
  userId: string;
  token: string;
  platform: 'ios' | 'android';
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Core details are deliberately separate from optional sensitive application answers. */
export interface ApplicantProfile {
  userId: string;
  contact: {
    name: string;
    /** Explicit parts prevent unsafe guessing from an international full name. */
    firstName?: string;
    lastName?: string;
    email: string;
    phone?: string;
  };
  location: string;
  workAuthorization: string;
  links: Record<string, string>;
  education: Array<{ school: string; degree?: string; field?: string; graduationDate?: string }>;
  reusableAnswers: Record<string, string>;
  resumeDocumentId?: string;
  /** Stored encrypted by the user store and returned only to the profile owner. */
  sensitive?: Record<string, unknown>;
  updatedAt: string;
}

export interface UserDocument {
  userId: string;
  documentId: string;
  fileName: string;
  contentType: string;
  objectKey: string;
  createdAt: string;
}

export interface DeliveryReceipt {
  userId: string;
  jobId: string;
  token: string;
  ticketId?: string;
  status: 'pending' | 'ok' | 'error';
  createdAt: string;
  updatedAt: string;
}

/** Reason a source fetch or snapshot did not produce a trusted result. */
export type SourceFailureCategory = 'http' | 'json' | 'transport' | 'identity' | 'link' | 'empty' | 'quality' | 'persistence';

export interface SourceCheckpoint {
  sourceId: string;
  etag?: string;
  documentEtags?: Record<string, string>;
  contentHash?: string;
  lastSuccessAt?: string;
  successfulFetches: number;
  lastRowCount?: number;
  lastRawCount?: number;
  /** Stable posting IDs in the last trusted complete snapshot. */
  activeExternalIds?: string[];
  lastRawRowCount?: number;
  lastWithheldRowCount?: number;
}

export type SourceHealthState = 'healthy' | 'degraded' | 'quarantined' | 'never-succeeded';
export type SourceIncidentState = 'open' | 'acknowledged' | 'resolved';
export type SourcePollTier = 'active' | 'quiet';
export type SourceOperationalStatus = 'active' | 'paused';
export type SourceOutcome =
  | 'changed'
  | 'unchanged'
  | 'failed'
  | 'success_changed'
  | 'success_unchanged_304'
  | 'success_unchanged_hash'
  | 'temporary_provider_error'
  | 'rate_limited'
  | 'invalid_configuration'
  | 'not_found'
  | 'invalid_schema'
  | 'incomplete_pagination'
  | 'unexpected_raw_zero'
  | 'application_host_mismatch'
  | 'catalog_write_failed';

export interface SourceHealth {
  sourceId: string;
  employerId?: string;
  provider?: 'github' | 'lever' | 'greenhouse' | 'unknown';
  region?: 'global' | 'eu' | 'unknown';
  state?: SourceHealthState;
  sourceStatus?: SourceOperationalStatus;
  pollTier?: SourcePollTier;
  lastAttemptAt: string;
  lastSuccessAt?: string;
  lastChangedAt?: string;
  freshnessMinutes?: number;
  outcome?: SourceOutcome;
  lastOutcome?: SourceOutcome;
  consecutiveFailures: number;
  etag?: string;
  contentHash?: string;
  snapshotHash?: string;
  counts?: ProcessedSnapshot['counts'];
  rawRows?: number;
  rawCount?: number;
  validRows?: number;
  validCount?: number;
  eligibleRows?: number;
  eligibleCount?: number;
  filteredRows?: number;
  filteredCount?: number;
  withheldRows?: number;
  withheldCount?: number;
  durationMs: number;
  failureCategory?: SourceFailureCategory;
  lastFailureCategory?: SourceFailureCategory;
  diagnosticCategory?: SourceFailureCategory | 'persistence' | 'quality';
  diagnostic?: string;
  lastSafeDiagnostic?: string;
  backoffUntil?: string;
  incidentState?: SourceIncidentState;
  incidentSeverity?: 'warning' | 'high';
  incidentOpenedAt?: string;
  incidentUpdatedAt?: string;
  incidentAcknowledgedAt?: string;
  incidentResolvedAt?: string;
  configVersion?: number;
  changedAt?: string;
  changedBy?: string;
  quarantinedAt?: string;
  quarantineReason?: string;
  recentRuns?: SourceRun[];
}

export interface SourceRun {
  runId: string;
  sourceId: string;
  provider?: SourceHealth['provider'];
  region?: SourceHealth['region'];
  outcome?: SourceOutcome;
  state: 'succeeded' | 'failed' | 'quarantined';
  startedAt: string;
  completedAt: string;
  durationMs: number;
  rawRows?: number;
  eligibleRows?: number;
  withheldRows?: number;
  failureCategory?: SourceFailureCategory;
  diagnostic?: string;
}

export interface SourceReference {
  sourceId: string;
  document: string;
  sourceUrl: string;
  row: number;
  postedAt?: string;
  /** Source-declared workplace arrangement; absent when the source does not declare one. */
  workMode?: 'remote' | 'hybrid' | 'onsite';
}

export interface Compensation {
  raw: string;
  maxHourlyUSD?: number;
}

/** Source-declared constraints; absence never implies that a constraint does not exist. */
export interface JobRequirements {
  requiresUsCitizenship: boolean;
  advancedDegreeRequired: boolean;
}

export interface SourceOccurrence extends SourceReference {
  externalId?: string;
  /** Source-local classification retained so job eligibility is independent of poll order. */
  technical?: boolean;
  company: string;
  title: string;
  location: string;
  season: string;
  applyUrl: string;
  compensation: Compensation;
  requirements?: JobRequirements;
  state: 'open' | 'closed';
}

export interface SourceOccurrenceState {
  sourceId: string;
  externalId: string;
  jobId: string;
  occurrence: SourceOccurrence;
  present: boolean;
  consecutiveOmissions: number;
  /** Snapshot in which this occurrence last changed. */
  changedSnapshotHash: string;
  changedAt: string;
}

/**
 * Read-time view of one occurrence. Change facts are durable per occurrence;
 * confirmation is derived from the source checkpoint, which already records the
 * active ID set, so confirming a snapshot costs no per-occurrence write.
 */
export interface SourceOccurrenceStatus extends SourceOccurrenceState {
  confirmedSnapshotHash?: string;
  confirmedAt?: string;
}

export interface NotificationEvent {
  eventId: string;
  sourceId: string;
  externalId: string;
  jobId: string;
  kind: 'new-job';
  createdAt: string;
}

export interface ProcessedListing extends SourceOccurrence {
  /** Stable within one source; row numbers are diagnostics only. */
  externalId?: string;
  fetchedAt: string;
  /** Classification is decided before persistence and never recomputed by the store. */
  technical?: boolean;
  /** The source truncated this title and it was reconstructed, so it may be approximate. */
  titleRepaired?: boolean;
}

/** @deprecated Use `ProcessedListing`; retained only while callers migrate. */
export type RawListing = ProcessedListing;

export interface SourcedPosting {
  sourceId: string;
  externalId: string;
  sourceUrl: string;
  document?: string;
  row?: number;
  fetchedAt: string;
  employer: {
    id?: string;
    name: string;
    authority: 'reviewed-registry' | 'source-row';
  };
  title: string;
  content: Array<{
    kind: 'description' | 'requirements' | 'additional';
    format: 'plain' | 'html' | 'markdown';
    value: string;
  }>;
  locations: string[];
  applyUrl: string;
  hostedUrl?: string;
  sourceState: 'open' | 'closed' | 'prospect';
  /**
   * `title` requires an internship signal in the posting title. `source` marks a
   * reviewed early-career-only document, where the source itself carries the
   * lifecycle signal and the title only decides technical classification.
   */
  lifecycleAuthority?: 'title' | 'source';
  publishedAt?: string;
  seasonHint?: string;
  classificationTags?: string[];
  declaredWorkMode?: string;
  compensationText?: string;
  declaredRequirements?: Partial<JobRequirements>;
}

export interface SourceSnapshot {
  sourceId: string;
  outcome: 'changed' | 'unchanged';
  complete: true;
  postings: SourcedPosting[];
  rawCount: number;
  contentHash: string;
  checkpoint: SourceCheckpoint;
}

export interface PostingDecision {
  externalId: string;
  /** `shelved` is stored but kept out of every catalog index and alert. */
  outcome: 'included' | 'shelved' | 'filtered' | 'withheld';
  reason:
    | 'prospect'
    | 'not-early-career'
    | 'nontechnical'
    | 'invalid-application-url'
    | 'aggregator-destination'
    | 'source-policy';
}

export interface ProcessedSnapshot {
  listings: ProcessedListing[];
  decisions: PostingDecision[];
  counts: {
    raw: number;
    valid: number;
    eligible: number;
    shelved: number;
    filtered: number;
    withheld: number;
  };
}

export interface NotificationState {
  smsPending: boolean;
  smsSentAt?: string;
  digestPending: boolean;
  digestedAt?: string;
}

export interface Internship {
  jobId: string;
  company: string;
  title: string;
  location: string;
  season: string;
  applyUrl: string;
  normalizedUrl: string;
  /** Present only after the official destination has resolved successfully. */
  applicationUrlValidatedAt?: string;
  /** A confirmed broken URL remains hidden until a source supplies a different destination. */
  invalidApplicationUrl?: string;
  fingerprint: string;
  compensation: Compensation;
  requirements?: JobRequirements;
  /** Set at ingest time; older stored records are classified from company name when read. */
  employerCategory?: EmployerCategory;
  sourceReferences: SourceOccurrence[];
  /** Persisted preprocessing result used by indexes and queries. */
  technical?: boolean;
  open: boolean;
  firstSeenAt: string;
  lastSeenAt: string;
  notification: NotificationState;
}

export interface SourceAdapter {
  readonly id: string;
  fetch(checkpoint?: SourceCheckpoint): Promise<SourceFetchResult>;
}

export interface SourceConnector {
  readonly id: string;
  fetch(checkpoint?: SourceCheckpoint): Promise<SourceSnapshot>;
}

export interface SourceFetchResult {
  sourceId: string;
  /** Total source rows before lifecycle/technical/link withholding filters. */
  rawRowCount?: number;
  listings: RawListing[];
  /** Rows withheld before publication because their application URL violates baseline policy. */
  rejectedApplicationUrls?: Array<{ row: number; url: string; reason: string }>;
  /** Processing a migrated connector already performed, so the runner never repeats it. */
  processed?: ProcessedSnapshot;
  checkpoint: SourceCheckpoint;
  notModified: boolean;
  unchangedReason?: 'not_modified' | 'content_hash';
}
