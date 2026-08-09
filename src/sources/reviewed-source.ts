/** Provider-neutral admission records shared by present and future ATS sources. */
export type ReviewedProvider = 'greenhouse' | 'lever' | 'ashby' | 'markdown';
export type ReviewedSourceStatus = 'shadow' | 'published';
export type ReviewedEvidenceState =
  | 'ownership-verified'
  | 'pending-review'
  | 'ambiguous-owner'
  | 'custom-host-review'
  | 'expired'
  | 'rejected';

export interface ReviewedBoardIdentity {
  provider: ReviewedProvider;
  /** Provider-issued identity, preserved exactly rather than derived from a company name. */
  boardKey: string;
  apiRegion: 'global' | 'eu';
}

export interface ReviewedApplicationHost {
  host: string;
  /** Required when the host is not the provider's standard application host. */
  justification?: string;
  reviewedAt?: string;
}

export interface ReviewedSourceRecord {
  id: string;
  company: string;
  identity: ReviewedBoardIdentity;
  careersUrl: string;
  admittedAt: string;
  evidenceState: ReviewedEvidenceState;
  allowedApplicationHosts: ReviewedApplicationHost[];
  status: ReviewedSourceStatus;
}

export interface EmployerCareersEvidence {
  provider: ReviewedProvider;
  boardKey: string;
  careersUrl: string;
  firstPartyEvidenceUrl: string;
  /** Exact provider board URL found on the employer-controlled page. */
  exactBoardUrl: string;
  evidenceExcerpt: string;
  observedJobUrl: string;
  verifiedAt: string;
  state: ReviewedEvidenceState;
  notes?: string;
}
