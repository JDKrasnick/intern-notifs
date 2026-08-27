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
  /** Submission timestamp, whether manually confirmed or detected from mail metadata. */
  appliedAt?: string;
  /** Mail-derived provenance is removed on Gmail disconnect without changing status. */
  detection?: { source: 'gmail'; detectedAt: string };
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
  /** Email is a separate channel and is never inferred from push opt-in. */
  emailAlertsEnabled?: boolean;
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

export const ACCOUNT_EXPORT_SCHEMA_VERSION = 1 as const;

export interface AccountDataExport {
  schemaVersion: typeof ACCOUNT_EXPORT_SCHEMA_VERSION;
  exportedAt: string;
  account: {
    profile: ApplicantProfile | null;
    applications: ApplicationRecord[];
    documents: Array<Pick<UserDocument, 'documentId' | 'fileName' | 'contentType' | 'createdAt'>>;
  };
}

export interface DeliveryReceipt {
  userId: string;
  jobId: string;
  /** Hash of the strong provider posting identity; absent on legacy receipts. */
  dedupeKey?: string;
  token: string;
  ticketId?: string;
  status: 'pending' | 'retryable' | 'ok' | 'error';
  attempts?: number;
  lastErrorCode?: string;
  lastErrorMessage?: string;
  lastErrorAt?: string;
  /** Provider-aware state; `status` remains during the legacy receipt migration. */
  deliveryState?: 'claimed' | 'accepted' | 'delivered' | 'definitive-failure' | 'unknown';
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
  provider?: 'github' | 'lever' | 'greenhouse' | 'ashby' | 'unknown';
  region?: 'global' | 'eu' | 'unknown';
  state?: SourceHealthState;
  sourceStatus?: SourceOperationalStatus;
  pollTier?: SourcePollTier;
  pollTierMode?: 'automatic' | 'operator';
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
  applicationLinksChecked?: number;
  applicationLinkFailures?: number;
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

export type MonitoringChecklistItemId =
  | 'review-fleet-health'
  | 'inspect-failed-extractions'
  | 'confirm-dead-letter-queues'
  | 'exercise-greenhouse-recovery'
  | 'exercise-lever-recovery'
  | 'exercise-ashby-recovery'
  | 'verify-reminder-delivery'
  | 'confirm-nightly-contract';

export interface MonitoringChecklistCompletion {
  completedAt: string;
  completedBy: string;
}

export interface MonitoringChecklist {
  period: string;
  completions: Partial<Record<MonitoringChecklistItemId, MonitoringChecklistCompletion>>;
  updatedAt?: string;
  updatedBy?: string;
  version: number;
}

export interface SourceReference {
  sourceId: string;
  /** Reviewed provenance attached at ingestion; legacy rows are resolved through the reviewed registry. */
  provenance?: OccurrenceProvenance;
  document: string;
  sourceUrl: string;
  row: number;
  postedAt?: string;
  /** Provider timestamp kept separate from when InternNotifs observed the row. */
  providerTimestamp?: ProviderTimestamp;
  /** Source-declared workplace arrangement; absent when the source does not declare one. */
  workMode?: 'remote' | 'hybrid' | 'onsite';
}

export type OccurrenceProvenance =
  | 'official-ats'
  | 'official-structured'
  | 'employer-submitted'
  | 'reviewed-community';

export type WorkAuthorizationStatus =
  | 'sponsorship-available'
  | 'no-sponsorship'
  | 'existing-authorization-required'
  | 'citizenship-required'
  | 'unknown';

export interface ApplicationDeadline {
  kind: 'date' | 'rolling';
  /** Required for `date`; the role closes at the end of this date in `timezone`. */
  date?: string;
  timezone?: string;
}

/** The meaning the provider assigns to a timestamp; it is never an InternNotifs observation time. */
export interface ProviderTimestamp {
  value: string;
  semantics: 'published' | 'updated';
}

/** Ordered from most to least authoritative for provider-neutral enrichment. */
export type EvidenceSource =
  | 'official-ats'
  | 'official-json-ld'
  | 'official-page'
  | 'reviewed-community'
  | 'deterministic-inference';

/** A compact reference to why a field has its current value. Full descriptions are never stored here. */
export interface FieldProvenance {
  source: EvidenceSource;
  sourceId: string;
  sourceUrl?: string;
  evidenceCode: string;
  contentHash?: string;
  observedAt?: string;
}

export interface ProvenancedValue<T> {
  value: T;
  provenance: FieldProvenance[];
}

export type InternshipProgramType = 'internship' | 'co-op' | 'apprenticeship' | 'new-grad' | 'entry-level';
export type SeasonTerm = 'spring' | 'summer' | 'fall' | 'winter';
export type SeasonEvidenceStatus = 'explicit' | 'inferred' | 'unspecified';

export interface SeasonIdentity {
  term?: SeasonTerm;
  year?: number;
  evidenceStatus: SeasonEvidenceStatus;
  provenance: FieldProvenance[];
}

export type EducationLevel = 'undergraduate' | 'masters' | 'mba' | 'doctoral';
export type MinimumDegree = 'none' | 'high-school' | 'associates' | 'bachelors' | 'masters' | 'doctoral';
export type EducationEvidenceStatus = 'explicit' | 'unspecified' | 'conflicting';

export interface GraduationDateWindow {
  /** Inclusive ISO-8601 year-month (`YYYY-MM`) or date (`YYYY-MM-DD`). */
  start?: string;
  /** Inclusive ISO-8601 year-month (`YYYY-MM`) or date (`YYYY-MM-DD`). */
  end?: string;
}

/**
 * Audience and minimum qualification are deliberately separate. An empty
 * `levels` list with `unspecified` matches every user and must be shown as
 * "Education level not specified by employer."
 */
export interface EducationAudience {
  levels: EducationLevel[];
  graduationDateWindow?: GraduationDateWindow;
  minimumDegree?: MinimumDegree;
  evidenceStatus: EducationEvidenceStatus;
  provenance: FieldProvenance[];
}

export type DisciplineTag = 'software' | 'ai-ml' | 'data' | 'infrastructure-cloud' | 'security' | 'quant' | 'product' | 'technical-design';
export type WorkMode = 'remote' | 'hybrid' | 'onsite' | 'unspecified';

export interface InternshipLocation {
  name: string;
  workMode: WorkMode;
  provenance: FieldProvenance[];
}

/** Descriptive grouping identity. None of these fields alone proves an exact duplicate. */
export interface InternshipIdentity {
  company: {
    canonicalId: string;
    displayName: ProvenancedValue<string>;
  };
  programType: ProvenancedValue<InternshipProgramType>;
  season: SeasonIdentity;
  education: EducationAudience;
  title: {
    official: ProvenancedValue<string>;
    display: ProvenancedValue<string>;
    search: ProvenancedValue<string>;
  };
  disciplines: Array<ProvenancedValue<DisciplineTag>>;
  locations: InternshipLocation[];
}

export type PostingProvider = 'greenhouse' | 'lever' | 'ashby' | 'workday' | 'bytedance' | 'unknown';
export type PostingAliasKind = 'provider-posting' | 'employer-requisition' | 'provider-route' | 'official-url' | 'application-url';

export interface PostingAlias {
  kind: PostingAliasKind;
  value: string;
  sourceUrl?: string;
}

/** Exact requisition identity. It is intentionally independent from `InternshipIdentity`. */
export interface PostingIdentity {
  provider: PostingProvider;
  tenant?: string;
  providerPostingId?: string;
  employerRequisitionId?: string;
  employerRequisitionAuthoritative?: boolean;
  canonicalApplicationUrl: string;
  aliases: PostingAlias[];
  canonicalJobId: string;
}

export interface Compensation {
  raw: string;
  minHourlyUSD?: number;
  maxHourlyUSD?: number;
  minAnnualUSD?: number;
  maxAnnualUSD?: number;
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
  locations?: string[];
  season: string;
  applyUrl: string;
  compensation: Compensation;
  requirements?: JobRequirements;
  state: 'open' | 'closed';
  /** Exact time this source was first linked to this catalog job, when known. */
  firstAttachedAt?: string;
  /** Legacy references predate attribution tracking and must not imply precision. */
  firstAttachedAtPrecision?: 'exact' | 'unknown';
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
  /** Immutable InternNotifs observation time, never a provider timestamp. */
  firstObservedAt?: string;
  /** `unknown` explicitly identifies legacy/backfilled records. */
  firstObservedAtPrecision?: 'exact' | 'unknown';
}

/**
 * Read-time view of one occurrence. Change facts are durable per occurrence;
 * confirmation is derived from the source checkpoint, which already records the
 * active ID set, so confirming a snapshot costs no per-occurrence write.
 */
export interface SourceOccurrenceStatus extends SourceOccurrenceState {
  confirmedSnapshotHash?: string;
  confirmedAt?: string;
  /** Alias for operator reports: confirmation comes from the durable source checkpoint. */
  lastConfirmedAt?: string;
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
  /** Whether the season came from this posting or a list-wide default. */
  seasonSource?: 'posting' | 'source-default';
  /** Exact provider-aware identity resolved before reconciliation. */
  postingIdentity?: PostingIdentity;
  /** Descriptive identity used for program grouping and audience filtering. */
  internshipIdentity?: InternshipIdentity;
}

/** @deprecated Use `ProcessedListing`; retained only while callers migrate. */
export type RawListing = ProcessedListing;

export interface SourcedPosting {
  sourceId: string;
  provenance?: OccurrenceProvenance;
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
   * `title` requires an explicit early-career signal in the posting title.
   * `posting` trusts a provider field that explicitly identifies this row as an
   * internship. `source` marks a reviewed early-career-only document.
   */
  lifecycleAuthority?: 'title' | 'posting' | 'source';
  publishedAt?: string;
  providerTimestamp?: ProviderTimestamp;
  seasonHint?: string;
  seasonHintAuthority?: 'posting' | 'source-default';
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
  locations?: string[];
  season: string;
  applyUrl: string;
  normalizedUrl: string;
  /** Lazily attached exact identity; absent on legacy rows. */
  postingIdentity?: PostingIdentity;
  /** Legacy/rollout rows may retain the earlier loose enrichment document until observed again. */
  internshipIdentity?: InternshipIdentity | Record<string, unknown>;
  /** Present only after the official destination has resolved successfully. */
  applicationUrlValidatedAt?: string;
  /** Version of employer-page metadata extraction applied to this role. */
  applicationPageMetadataVersion?: number;
  /** A confirmed broken URL remains hidden until a source supplies a different destination. */
  invalidApplicationUrl?: string;
  fingerprint: string;
  compensation: Compensation;
  /** Provider-neutral status. Missing legacy values are rendered as `unknown`. */
  workAuthorizationStatus?: WorkAuthorizationStatus;
  applicationDeadline?: ApplicationDeadline;
  graduationWindow?: GraduationDateWindow;
  programType?: InternshipProgramType;
  workMode?: WorkMode;
  /** Employer co-attribution for accepted field-level evidence; history remains in proposal/audit tables. */
  employerMetadataAttribution?: Record<string, Array<{ organizationId: string; proposalId: string; evidenceAt: string }>>;
  requirements?: JobRequirements;
  /** Set at ingest time; older stored records are classified from company name when read. */
  employerCategory?: EmployerCategory;
  sourceReferences: SourceOccurrence[];
  /** Persisted preprocessing result used by indexes and queries. */
  technical?: boolean;
  open: boolean;
  /** Immutable time InternNotifs first observed this canonical catalog role. */
  firstSeenAt: string;
  /** Immutable time this canonical role first became visible; absent only on legacy rows. */
  catalogVisibleAt?: string;
  /** Baseline roles remain public but rank after normal roles; legacy rows imply normal. */
  catalogRecency?: 'normal' | 'baseline';
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
  /** Sanitized conditional-request diagnostics; validator values are never exposed. */
  conditionalRequest?: {
    attempted: boolean;
    notModified: boolean;
    validatorChanged?: boolean;
  };
}
