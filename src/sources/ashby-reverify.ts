import { ashbyEvidenceViolations, excerptProvesAshbyBoard, type AshbyOwnershipEvidence } from './ashby-evidence.js';
import { ashbyBoardNameFromUrl } from './ashby-ledger.js';

export type AshbyReverificationResult =
  | { state: 'ok'; boardName: string; stillProven: boolean; finalUrl: string }
  | { state: 'malformed-record' | 'http-error' | 'transport-error' | 'redirect-error'; boardName: string; status?: number; violations?: string[] };

const MAX_FIRST_PARTY_SCRIPTS = 100;
const MAX_SCRIPT_DEPTH = 2;
const MAX_RESOURCE_BYTES = 2_000_000;

function resourceProvesAshbyBoard(markup: string, boardName: string): boolean {
  const escaped = boardName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return excerptProvesAshbyBoard(markup, boardName)
    || new RegExp(`api\\.ashbyhq\\.com/posting-api/job-board/${escaped}(?:[?&"'\\s<]|$)`).test(markup)
    || new RegExp(`api\\.ashbyhq\\.com/posting-api/job-board/.{0,2000}["']${escaped}["']`, 's').test(markup);
}

function sameHostOrSubdomain(left: string, right: string): boolean {
  return left === right || left.endsWith(`.${right}`) || right.endsWith(`.${left}`);
}

function scriptUrls(markup: string, baseUrl: string): string[] {
  const candidates = [
    ...markup.matchAll(/<(?:script|link)\b[^>]*(?:src|href)=["']([^"']+\.js(?:\?[^"']*)?)["']/gi),
    ...markup.matchAll(/["']((?:https?:\/\/|\/|\.\.?\/|static\/)[^"']+\.js(?:\?[^"']*)?)["']/gi),
  ].map((match) => match[1]!);
  const base = new URL(baseUrl);
  return [...new Set(candidates.flatMap((candidate) => {
    try {
      const url = candidate.startsWith('static/') && base.pathname.includes('/_next/')
        ? new URL(`/_next/${candidate}`, base.origin)
        : new URL(candidate, base);
      return url.protocol === 'https:' && url.hostname.toLowerCase() === base.hostname.toLowerCase() ? [url.href] : [];
    } catch { return []; }
  }))];
}

async function scriptsProveAshbyBoard(markup: string, firstPartyUrl: string, boardName: string, fetchImpl: typeof fetch) {
  const queued = scriptUrls(markup, firstPartyUrl).map((url) => ({ url, depth: 1 }));
  const seen = new Set<string>();
  while (queued.length && seen.size < MAX_FIRST_PARTY_SCRIPTS) {
    const next = queued.shift()!;
    if (seen.has(next.url)) continue;
    seen.add(next.url);
    try {
      const response = await fetchImpl(next.url, { redirect: 'follow', signal: AbortSignal.timeout(15_000) });
      if (!response.ok || new URL(response.url || next.url).hostname.toLowerCase() !== new URL(firstPartyUrl).hostname.toLowerCase()) continue;
      const script = (await response.text()).slice(0, MAX_RESOURCE_BYTES);
      if (resourceProvesAshbyBoard(script, boardName)) return true;
      if (next.depth < MAX_SCRIPT_DEPTH) {
        queued.push(...scriptUrls(script, next.url).map((url) => ({ url, depth: next.depth + 1 })));
      }
    } catch { /* A missing optional bundle does not invalidate other first-party evidence. */ }
  }
  return false;
}

export async function recheckAshbyEvidence(evidence: AshbyOwnershipEvidence, fetchImpl: typeof fetch = fetch): Promise<AshbyReverificationResult> {
  const violations = ashbyEvidenceViolations(evidence);
  if (violations.length) return { state: 'malformed-record', boardName: evidence.boardKey, violations };
  let response: Response;
  try { response = await fetchImpl(evidence.firstPartyEvidenceUrl, { redirect: 'follow', signal: AbortSignal.timeout(15_000) }); }
  catch { return { state: 'transport-error', boardName: evidence.boardKey }; }
  if (!response.ok) return { state: 'http-error', boardName: evidence.boardKey, status: response.status };
  const finalUrl = response.url || evidence.firstPartyEvidenceUrl;
  try {
    const finalHost = new URL(finalUrl).hostname.toLowerCase();
    const evidenceHost = new URL(evidence.firstPartyEvidenceUrl).hostname.toLowerCase();
    if (!sameHostOrSubdomain(finalHost, evidenceHost)) {
      if (ashbyBoardNameFromUrl(finalUrl) === evidence.boardKey) {
        return { state: 'ok', boardName: evidence.boardKey, stillProven: true, finalUrl };
      }
      return { state: 'redirect-error', boardName: evidence.boardKey };
    }
  } catch { return { state: 'redirect-error', boardName: evidence.boardKey }; }
  const markup = (await response.text()).slice(0, 2_000_000);
  const stillProven = resourceProvesAshbyBoard(markup, evidence.boardKey)
    || await scriptsProveAshbyBoard(markup, finalUrl, evidence.boardKey, fetchImpl);
  return { state: 'ok', boardName: evidence.boardKey, stillProven, finalUrl };
}
