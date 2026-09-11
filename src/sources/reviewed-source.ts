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

export interface SourcePromotionSnapshotEvidence {
  runId: string;
  completedAt: string;
  outcome: 'success_changed' | 'success_unchanged_304' | 'success_unchanged_hash';
  rawRows: number;
  eligibleRows: number;
  withheldRows: number;
  applicationLinksChecked: number;
  applicationLinkFailures: number;
  complete: boolean;
  identityVerified: boolean;
  schemaValid: boolean;
}

/** Durable, human-approved evidence required before a reviewed source may publish. */
export interface SourcePromotionEvidence {
  approvedAt: string;
  approvedBy: string;
  quietBaselineApproved: boolean;
  stableIdentity: boolean;
  stableApplicationHosts: boolean;
  snapshots: SourcePromotionSnapshotEvidence[];
  /** Explicit owner authorization to publish before the normal observation window completes. */
  observationWindowOverride?: {
    reason: string;
    followUpAfter: string;
  };
}

/**
 * Owner declaration that a reviewed board is legitimately empty right now — a
 * seasonal or unused board rather than a parser regression. It waives only the
 * row-count drift guard; identity, schema, host, and link checks still run.
 */
export interface EmptyBoardAcknowledgement {
  /** Owner who re-checked the live board against its reviewed identity. */
  acknowledgedBy: string;
  /** UTC time of that check. */
  acknowledgedAt: string;
  /** Why the empty board is expected; re-read at the next re-verification. */
  reason: string;
}

/**
 * Rejection reasons for an owner's empty-board declaration; empty means valid.
 * The timestamp is not compared against the re-verification clock: an
 * acknowledgement is recorded whenever the owner re-checks the board, so it
 * legitimately postdates admission.
 */
export function emptyBoardAcknowledgementViolations(acknowledgement: EmptyBoardAcknowledgement): string[] {
  const violations: string[] = [];
  if (!acknowledgement.acknowledgedBy.trim()) violations.push('empty-board acknowledgement lacks an owner');
  if (!acknowledgement.reason.trim()) violations.push('empty-board acknowledgement lacks a reason');
  if (Number.isNaN(Date.parse(acknowledgement.acknowledgedAt))) violations.push('empty-board acknowledgement timestamp is invalid');
  return violations;
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
  promotionEvidence?: SourcePromotionEvidence;
  /**
   * Set only after the owner confirms the board itself is empty. A zero-row
   * snapshot is then expected rather than treated as parser drift, so the
   * source keeps monitoring and picks up roles when the board refills.
   */
  emptyBoardAcknowledged?: EmptyBoardAcknowledgement;
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
