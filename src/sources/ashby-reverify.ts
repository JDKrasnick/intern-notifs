import { ashbyEvidenceViolations, excerptProvesAshbyBoard, type AshbyOwnershipEvidence } from './ashby-evidence.js';

export type AshbyReverificationResult =
  | { state: 'ok'; boardName: string; stillProven: boolean; finalUrl: string }
  | { state: 'malformed-record' | 'http-error' | 'transport-error' | 'redirect-error'; boardName: string; status?: number; violations?: string[] };

export async function recheckAshbyEvidence(evidence: AshbyOwnershipEvidence, fetchImpl: typeof fetch = fetch): Promise<AshbyReverificationResult> {
  const violations = ashbyEvidenceViolations(evidence);
  if (violations.length) return { state: 'malformed-record', boardName: evidence.boardKey, violations };
  let response: Response;
  try { response = await fetchImpl(evidence.firstPartyEvidenceUrl, { redirect: 'follow', signal: AbortSignal.timeout(15_000) }); }
  catch { return { state: 'transport-error', boardName: evidence.boardKey }; }
  if (!response.ok) return { state: 'http-error', boardName: evidence.boardKey, status: response.status };
  const finalUrl = response.url || evidence.firstPartyEvidenceUrl;
  try {
    if (new URL(finalUrl).hostname.toLowerCase() !== new URL(evidence.firstPartyEvidenceUrl).hostname.toLowerCase()) {
      return { state: 'redirect-error', boardName: evidence.boardKey };
    }
  } catch { return { state: 'redirect-error', boardName: evidence.boardKey }; }
  const markup = (await response.text()).slice(0, 2_000_000);
  return { state: 'ok', boardName: evidence.boardKey, stillProven: excerptProvesAshbyBoard(markup, evidence.boardKey), finalUrl };
}
