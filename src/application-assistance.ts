import type { Internship } from './types.js';
import type { AssistanceEligibility } from './application-automation.js';
import { isGreenhouseApplicationUrl } from './greenhouse-headed.js';
import { isLeverApplicationUrl } from './lever-headed.js';

export type AssistanceReasonCode =
  | 'greenhouse-headed-pilot'
  | 'lever-headed-pilot'
  | 'destination-policy-prohibits-automation'
  | 'partner-submission-requires-employer-authorization'
  | 'destination-not-reviewed';

export interface AssistanceAvailability {
  eligibility: AssistanceEligibility;
  reasonCode: AssistanceReasonCode;
  primaryAction: 'assist-in-safari' | 'open-assisted-browser' | 'open-official-form';
}

function hostname(url: string) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * A reviewed, default-deny destination registry. Entries are intentionally
 * code-reviewed rather than user-configurable: a user cannot opt into
 * automation for a destination whose terms have not been reviewed.
 */
export function assistanceAvailability(job: Pick<Internship, 'applyUrl'>, applyMode?: 'official-form' | 'partner'): AssistanceAvailability {
  if (applyMode === 'partner') {
    return {
      eligibility: 'partner-only',
      reasonCode: 'partner-submission-requires-employer-authorization',
      primaryAction: 'open-official-form',
    };
  }

  const host = hostname(job.applyUrl);
  if (host === 'linkedin.com' || host.endsWith('.linkedin.com')) {
    return {
      eligibility: 'manual-only',
      reasonCode: 'destination-policy-prohibits-automation',
      primaryAction: 'open-official-form',
    };
  }
  if (isGreenhouseApplicationUrl(job.applyUrl)) {
    return {
      eligibility: 'headed-supported',
      reasonCode: 'greenhouse-headed-pilot',
      primaryAction: 'assist-in-safari',
    };
  }
  if (isLeverApplicationUrl(job.applyUrl)) {
    return {
      eligibility: 'headed-supported',
      reasonCode: 'lever-headed-pilot',
      primaryAction: 'assist-in-safari',
    };
  }
  return {
    eligibility: 'manual-only',
    reasonCode: 'destination-not-reviewed',
    primaryAction: 'open-official-form',
  };
}
