import type { ApplicantProfile, ApplicationRecord, Internship } from './types.js';

export interface EmployerProviderAdapter {
  readonly employer: string;
  isEligible(job: Internship): boolean;
  requiredFields(job: Internship): string[];
  validateDraft(profile: ApplicantProfile, job: Internship): string[];
  requestUserReview(profile: ApplicantProfile, job: Internship): Promise<{ approved: boolean }>;
  submit(profile: ApplicantProfile, job: Internship): Promise<{ receiptId: string }>;
  handleReceipt(receiptId: string): Promise<'accepted' | 'rejected' | 'pending'>;
}

/** Explicit feature flags are the trust boundary for partner submission. */
export class EmployerIntegrationRegistry {
  constructor(private readonly adapters: EmployerProviderAdapter[] = [], private readonly enabledEmployers = new Set<string>()) {}
  forJob(job: Internship): EmployerProviderAdapter | undefined { return this.adapters.find((adapter) => this.enabledEmployers.has(adapter.employer) && adapter.isEligible(job)); }
  applyMode(job: Internship): ApplicationRecord['applyMode'] { return this.forJob(job) ? 'partner' : 'official-form'; }
}

/**
 * Greenhouse's Job Board API is intentionally dormant until an employer grants
 * credentials and validates a form mapping. It gives the profile model a concrete
 * first-partner contract without exposing an unauthorized submit path.
 */
export class GreenhouseJobBoardAdapter implements EmployerProviderAdapter {
  readonly employer = 'greenhouse';
  isEligible(job: Internship) { try { return new URL(job.applyUrl).hostname.endsWith('greenhouse.io'); } catch { return false; } }
  requiredFields(_job: Internship) { void _job; return ['contact.name', 'contact.email', 'location', 'workAuthorization', 'resumeDocumentId', 'education']; }
  validateDraft(profile: ApplicantProfile, job: Internship) { return this.requiredFields(job).filter((field) => { const [parent, child] = field.split('.'); return child ? !(profile[parent as keyof ApplicantProfile] as Record<string, unknown> | undefined)?.[child] : !profile[parent as keyof ApplicantProfile]; }); }
  async requestUserReview(_profile: ApplicantProfile, _job: Internship) { void _profile; void _job; return { approved: false }; }
  async submit(_profile: ApplicantProfile, _job: Internship): Promise<{ receiptId: string }> { void _profile; void _job; throw new Error('Greenhouse direct submission is disabled until an authorized employer integration is configured'); }
  async handleReceipt(_receiptId: string) { void _receiptId; return 'pending' as const; }
}
