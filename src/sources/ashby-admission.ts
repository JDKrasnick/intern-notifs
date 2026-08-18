import { ashbyEvidenceViolations, type AshbyOwnershipEvidence } from './ashby-evidence.js';
import type { AshbyProbeResult } from './ashby-probe.js';
import type { ReviewedSourceRecord } from './reviewed-source.js';

export interface AshbyAdmissionReview {
  reviewerApprovedOwnership: boolean;
  reviewerApprovedAdmission: boolean;
  company: string;
  evidence: AshbyOwnershipEvidence;
  probe: AshbyProbeResult;
  proposedSource: ReviewedSourceRecord;
}

/**
 * Pure, bounded verifier: at most ten host decisions and one probe artifact. It can
 * validate a human decision but cannot write the registry or publish a source.
 */
export function ashbyAdmissionViolations(review: AshbyAdmissionReview): string[] {
  const violations = ashbyEvidenceViolations(review.evidence);
  if (!review.reviewerApprovedOwnership) violations.push('ownership approval is required');
  if (!review.reviewerApprovedAdmission) violations.push('registry admission approval is required');
  if (!review.company.trim()) violations.push('company is empty');
  if (review.evidence.allowedApplicationHosts.length > 10) violations.push('allowed application host review exceeds the limit of 10');
  if (review.probe.state !== 'ok') violations.push(`probe state is ${review.probe.state}, not ok`);
  else {
    if (review.probe.boardName !== review.evidence.boardKey) violations.push('probe board does not match evidence board');
    if (review.probe.apiVersion !== '1' || review.probe.apiRegion !== 'global') violations.push('probe API identity is unsupported');
    if (review.probe.malformedRows || review.probe.boardPathViolations) violations.push('probe reports schema or board-path violations');
    if (review.probe.technicalEarlyCareerRoles < 1 && !review.evidence.initialRoleRequirementOverride) {
      violations.push('initial admission requires a current technical early-career role');
    }
    if (review.probe.technicalEarlyCareerRoles !== review.evidence.initialTechnicalEarlyCareerRoles) {
      violations.push('recorded initial technical-role count does not match the probe');
    }
    const allowed = new Set(review.evidence.allowedApplicationHosts.map(({ host }) => host.toLowerCase()));
    const unexpected = Object.keys(review.probe.applicationHostSummary).filter((host) => !allowed.has(host));
    if (unexpected.length) violations.push(`probe reports unreviewed application hosts: ${unexpected.join(', ')}`);
  }
  const source = review.proposedSource;
  if (source.status !== 'shadow') violations.push('new admissions must enter shadow');
  if (source.identity.provider !== 'ashby' || source.identity.boardKey !== review.evidence.boardKey) violations.push('proposed source identity does not match evidence');
  if (source.evidenceState !== review.evidence.state) violations.push('proposed source evidence state does not match evidence');
  return violations;
}
