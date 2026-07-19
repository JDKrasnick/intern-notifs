import type { JobFilter } from './core/filters.js';

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

export interface UserPreferences {
  userId: string;
  filter: JobFilter;
  alertsEnabled: boolean;
  onboardingComplete: boolean;
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
  contact: { name: string; email: string; phone?: string };
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
}

export interface Compensation {
  raw: string;
  maxHourlyUSD?: number;
}

export interface SourceOccurrence extends SourceReference {
  company: string;
  title: string;
  location: string;
  season: string;
  applyUrl: string;
  compensation: Compensation;
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
  fingerprint: string;
  compensation: Compensation;
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
  checkpoint: SourceCheckpoint;
  notModified: boolean;
}
