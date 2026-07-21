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

export interface SourceCheckpoint {
  sourceId: string;
  etag?: string;
  documentEtags?: Record<string, string>;
  contentHash?: string;
  lastSuccessAt?: string;
  successfulFetches: number;
  lastRowCount?: number;
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
  company: string;
  title: string;
  location: string;
  season: string;
  applyUrl: string;
  compensation: Compensation;
  requirements?: JobRequirements;
  state: 'open' | 'closed';
}

export interface RawListing extends SourceOccurrence {
  fetchedAt: string;
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
  open: boolean;
  firstSeenAt: string;
  lastSeenAt: string;
  notification: NotificationState;
}

export interface SourceAdapter {
  readonly id: string;
  fetch(checkpoint?: SourceCheckpoint): Promise<SourceFetchResult>;
}

export interface SourceFetchResult {
  sourceId: string;
  listings: RawListing[];
  /** Rows withheld before publication because their application URL violates baseline policy. */
  rejectedApplicationUrls?: Array<{ row: number; url: string; reason: string }>;
  checkpoint: SourceCheckpoint;
  notModified: boolean;
}
