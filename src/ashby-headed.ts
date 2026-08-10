import {
  planGreenhouseFields,
  type GreenhousePage,
  type HeadedGreenhouseBrowser,
  type SimpleApplicantValues,
} from './greenhouse-headed.js';
import { reviewedAshbySources, type ReviewedAshbySource } from './sources/ashby-config.js';

export type AshbyDetection =
  | { outcome: 'ready'; boardKey: string; scrollTargetId?: string }
  | { outcome: 'manual'; reason: 'unapproved-route' | 'challenge' | 'host-path-mismatch' };

const postingUuid = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}';

/** Published board identities are the only Ashby companion allowlist. */
export function publishedAshbyBoardKeys(sources: readonly ReviewedAshbySource[] = reviewedAshbySources) {
  return new Set(sources
    .filter((source) => source.status === 'published')
    .map((source) => source.identity.boardKey));
}

function ashbyRoute(url: string) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'jobs.ashbyhq.com'
      || parsed.port || parsed.username || parsed.password) return undefined;
    const match = new RegExp(`^/([^/]+)/(${postingUuid})/application$`).exec(parsed.pathname);
    if (!match) return undefined;
    return { boardKey: match[1], postingId: match[2] };
  } catch {
    return undefined;
  }
}

/**
 * Ashby board keys are deliberately compared case-sensitively. They come from
 * a human-reviewed source record and must not be inferred from an employer.
 */
export function isAshbyApplicationUrl(url: string, sources?: readonly ReviewedAshbySource[]) {
  const route = ashbyRoute(url);
  return Boolean(route && publishedAshbyBoardKeys(sources).has(route.boardKey));
}

export function detectAshbyApplication(page: GreenhousePage, sources?: readonly ReviewedAshbySource[]): AshbyDetection {
  const route = ashbyRoute(page.url);
  if (!route) return { outcome: 'manual', reason: 'host-path-mismatch' };
  if (!publishedAshbyBoardKeys(sources).has(route.boardKey)) return { outcome: 'manual', reason: 'unapproved-route' };
  if (page.challenge) return { outcome: 'manual', reason: 'challenge' };
  return {
    outcome: 'ready',
    boardKey: route.boardKey,
    scrollTargetId: page.fields.find((field) => field.visible && field.enabled)?.id,
  };
}

/** Ashby forms use the shared, exact-only contact policy. */
export function runAshbyHeadedAssistant(
  browser: HeadedGreenhouseBrowser,
  page: GreenhousePage,
  values: SimpleApplicantValues,
  sources?: readonly ReviewedAshbySource[],
) {
  const detection = detectAshbyApplication(page, sources);
  const fields = planGreenhouseFields(page, values);
  if (detection.outcome !== 'ready') return { detection, fields };
  if (detection.scrollTargetId) browser.scrollIntoView(detection.scrollTargetId);
  for (const field of fields) {
    if (field.treatment !== 'auto-fill' || !field.resolved || !field.valueRef) continue;
    const value = field.valueRef.key === 'contact.name' ? values.contact.name
      : field.valueRef.key === 'contact.firstName' ? values.contact.firstName
        : field.valueRef.key === 'contact.lastName' ? values.contact.lastName
          : field.valueRef.key === 'contact.email' ? values.contact.email
            : field.valueRef.key === 'contact.phone' ? values.contact.phone
              : undefined;
    if (value) browser.fill(field.controlId, value);
  }
  return { detection, fields };
}
