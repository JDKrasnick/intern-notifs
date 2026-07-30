/**
 * Stage 5 of `docs/lever-ownership-verification-plan.md`: recheck a recorded
 * ownership evidence record against the employer's page as it is today.
 *
 * This exists for two reasons. Ownership decays — employers leave Lever, get
 * acquired, or rename — and `evidenceExcerpt` is the one field an agent authors
 * freely. The manifest gate can only check that the excerpt mentions the site;
 * only refetching the page can check that the excerpt was actually copied off it.
 * An agent that paraphrases its evidence produces `link-only`, which is a finding.
 */
import { LEVER_APPLICATION_HOST } from './lever-ledger.js';
import { evidenceViolations, type LeverOwnershipEvidence } from './lever-evidence.js';

export type LeverExcerptFidelity =
  /** The recorded excerpt still appears on the page, whitespace aside. */
  | 'exact'
  /** The page still links the site, but not with the markup that was recorded. */
  | 'link-only'
  /** The page no longer links the site at all. The evidence is gone. */
  | 'missing';

export type LeverEvidenceRecheck =
  | {
    state: 'ok';
    site: string;
    firstPartyEvidenceUrl: string;
    fidelity: LeverExcerptFidelity;
    /** True only when the page still proves what the record claims. */
    stillProven: boolean;
    recheckedAt: string;
  }
  | {
    state: 'malformed-record' | 'http-error' | 'transport-error';
    site: string;
    firstPartyEvidenceUrl: string;
    status?: number;
    violations?: string[];
    recheckedAt: string;
  };

function collapse(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export async function recheckLeverEvidence(
  evidence: LeverOwnershipEvidence,
  fetchImpl: typeof fetch = fetch,
  recheckedAt = new Date().toISOString(),
): Promise<LeverEvidenceRecheck> {
  const base = { site: evidence.site, firstPartyEvidenceUrl: evidence.firstPartyEvidenceUrl, recheckedAt };
  const violations = evidenceViolations(evidence);
  if (violations.length) return { ...base, state: 'malformed-record', violations };

  let response: Response;
  try {
    response = await fetchImpl(evidence.firstPartyEvidenceUrl, { redirect: 'follow', signal: AbortSignal.timeout(20_000) });
  } catch {
    return { ...base, state: 'transport-error' };
  }
  if (!response.ok) return { ...base, state: 'http-error', status: response.status };
  const page = collapse(await response.text());

  const linkPattern = new RegExp(`${LEVER_APPLICATION_HOST.replace(/\./g, '\\.')}/${evidence.site.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9-])`, 'i');
  const fidelity: LeverExcerptFidelity = !linkPattern.test(page)
    ? 'missing'
    : page.includes(collapse(evidence.evidenceExcerpt))
      ? 'exact'
      : 'link-only';
  return { ...base, state: 'ok', fidelity, stillProven: fidelity !== 'missing' };
}
