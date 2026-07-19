export type ApplicationStatus =
  | 'saved' | 'applied' | 'assessment' | 'interview' | 'offer' | 'rejected' | 'withdrawn';

export interface ApplicationRecord {
  applicationId: string;
  jobId: string;
  status: ApplicationStatus;
  updatedAt: string;
  createdAt: string;
  notes?: string;
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
