import { earlyCareerRequirements, hasLifecycleTitleSignal, htmlToText, inferSeason, inferWorkMode } from '../core/early-career.js';
import { assessTechnicalRole } from '../core/filters.js';
import { parseCompensation } from '../core/normalize.js';
import { isTruncatedTitle, repairTitle } from '../core/role-title.js';
import { applicationUrlRejection } from '../sources/quality.js';
import type {
  JobRequirements,
  PostingDecision,
  ProcessedListing,
  ProcessedSnapshot,
  SourceSnapshot,
  SourcedPosting,
} from '../types.js';

function markdownToText(value: string): string {
  return htmlToText(value
    .replace(/!\[[^\]]*]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
    .replace(/[*_`>#-]/g, ' '));
}

function contentText(posting: SourcedPosting): string {
  return posting.content.map((part) => {
    if (part.format === 'html') return htmlToText(part.value);
    if (part.format === 'markdown') return markdownToText(part.value);
    return htmlToText(part.value);
  }).join(' ').replace(/\s+/g, ' ').trim();
}

function requirements(posting: SourcedPosting, content: string): JobRequirements {
  const inferred = earlyCareerRequirements(content);
  return {
    requiresUsCitizenship: posting.declaredRequirements?.requiresUsCitizenship ?? inferred.requiresUsCitizenship,
    advancedDegreeRequired: posting.declaredRequirements?.advancedDegreeRequired ?? inferred.advancedDegreeRequired,
  };
}

function withheldReason(url: string): PostingDecision['reason'] | undefined {
  const rejection = applicationUrlRejection(url);
  if (!rejection) return undefined;
  return rejection.includes('aggregator') ? 'aggregator-destination' : 'invalid-application-url';
}

export function processPosting(
  posting: SourcedPosting,
  employerTitles: readonly string[] = [],
): { listing?: ProcessedListing; decision: PostingDecision } {
  if (posting.sourceState === 'prospect') {
    return { decision: { externalId: posting.externalId, outcome: 'filtered', reason: 'prospect' } };
  }
  const sourceTitle = htmlToText(posting.title);
  const title = repairTitle(sourceTitle, employerTitles);
  const content = contentText(posting);
  if (posting.lifecycleAuthority !== 'source' && posting.lifecycleAuthority !== 'posting' && !hasLifecycleTitleSignal(title)) {
    return { decision: { externalId: posting.externalId, outcome: 'filtered', reason: 'not-early-career' } };
  }
  const company = htmlToText(posting.employer.name);
  const location = posting.locations.map(htmlToText).filter(Boolean).join(' / ') || 'Unspecified';
  const titleSeason = inferSeason(title, '');
  const season = titleSeason !== 'ongoing' ? titleSeason : posting.seasonHint ?? inferSeason('', content);
  const classificationTitle = [title, ...(posting.classificationTags ?? []).map(htmlToText)].filter(Boolean).join(' ');
  const assessment = assessTechnicalRole({ company, title: classificationTitle, location, season }, content);
  const urlReason = withheldReason(posting.applyUrl);
  if (urlReason) {
    return { decision: { externalId: posting.externalId, outcome: 'withheld', reason: urlReason } };
  }
  // A structured provider field is authoritative; prose only fills the gap when
  // the source declares nothing usable.
  const workMode = inferWorkMode(posting.declaredWorkMode) ?? inferWorkMode(`${location} ${content}`);
  const listing: ProcessedListing = {
    sourceId: posting.sourceId,
    externalId: posting.externalId,
    document: posting.document ?? posting.externalId,
    sourceUrl: posting.sourceUrl,
    row: posting.row ?? 1,
    company,
    title,
    location,
    season,
    ...(titleSeason === 'ongoing' && posting.seasonHintAuthority === 'source-default'
      ? { seasonSource: 'source-default' as const }
      : {}),
    applyUrl: posting.applyUrl,
    compensation: parseCompensation(posting.compensationText ?? content),
    requirements: requirements(posting, content),
    state: posting.sourceState,
    ...(posting.publishedAt ? { postedAt: posting.publishedAt } : {}),
    ...(posting.providerTimestamp ? { providerTimestamp: posting.providerTimestamp } : {}),
    ...(workMode ? { workMode } : {}),
    fetchedAt: posting.fetchedAt,
    technical: assessment.technical,
    ...(title === sourceTitle ? {} : { titleRepaired: true }),
  };
  // A non-technical early-career role is still worth keeping: it is persisted,
  // stays out of every catalog index and alert, and remains available if the
  // catalog's scope ever widens.
  return assessment.technical
    ? { listing, decision: { externalId: posting.externalId, outcome: 'included', reason: 'source-policy' } }
    : { listing, decision: { externalId: posting.externalId, outcome: 'shelved', reason: 'nontechnical' } };
}

export function processSnapshot(snapshot: SourceSnapshot): ProcessedSnapshot {
  const listings: ProcessedListing[] = [];
  const decisions: PostingDecision[] = [];
  // A source that truncates one row usually publishes the same role whole
  // elsewhere, so whole titles for an employer repair that employer's cut ones.
  const employerTitles = new Map<string, string[]>();
  for (const posting of snapshot.postings) {
    if (isTruncatedTitle(posting.title)) continue;
    const key = htmlToText(posting.employer.name).toLowerCase();
    employerTitles.set(key, [...(employerTitles.get(key) ?? []), htmlToText(posting.title)]);
  }
  for (const posting of snapshot.postings) {
    const result = processPosting(posting, employerTitles.get(htmlToText(posting.employer.name).toLowerCase()) ?? []);
    decisions.push(result.decision);
    if (result.listing) listings.push(result.listing);
  }
  const count = (outcome: PostingDecision['outcome']) => decisions.filter((decision) => decision.outcome === outcome).length;
  const shelved = count('shelved');
  return {
    listings,
    decisions,
    counts: {
      raw: snapshot.rawCount,
      valid: snapshot.postings.length,
      eligible: listings.length - shelved,
      shelved,
      filtered: count('filtered'),
      withheld: count('withheld'),
    },
  };
}
