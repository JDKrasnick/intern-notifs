import { earlyCareerRequirements, hasLifecycleTitleSignal, htmlToText, inferSeason, inferWorkMode } from '../core/early-career.js';
import { isTechnicalJob } from '../core/filters.js';
import { parseCompensation } from '../core/normalize.js';
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

export function processPosting(posting: SourcedPosting): { listing?: ProcessedListing; decision: PostingDecision } {
  if (posting.sourceState === 'prospect') {
    return { decision: { externalId: posting.externalId, outcome: 'filtered', reason: 'prospect' } };
  }
  const title = htmlToText(posting.title);
  const content = contentText(posting);
  if (posting.lifecycleAuthority !== 'source' && !hasLifecycleTitleSignal(title)) {
    return { decision: { externalId: posting.externalId, outcome: 'filtered', reason: 'not-early-career' } };
  }
  const company = htmlToText(posting.employer.name);
  const location = posting.locations.map(htmlToText).filter(Boolean).join(' / ') || 'Unspecified';
  const season = posting.seasonHint ?? inferSeason(title, content);
  const classificationTitle = [title, ...(posting.classificationTags ?? []).map(htmlToText)].filter(Boolean).join(' ');
  if (!isTechnicalJob({ company, title: classificationTitle, location, season })) {
    return { decision: { externalId: posting.externalId, outcome: 'filtered', reason: 'nontechnical' } };
  }
  const urlReason = withheldReason(posting.applyUrl);
  if (urlReason) {
    return { decision: { externalId: posting.externalId, outcome: 'withheld', reason: urlReason } };
  }
  const workMode = inferWorkMode(posting.declaredWorkMode ?? `${location} ${content}`);
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
    applyUrl: posting.applyUrl,
    compensation: parseCompensation(posting.compensationText ?? content),
    requirements: requirements(posting, content),
    state: posting.sourceState,
    ...(posting.publishedAt ? { postedAt: posting.publishedAt } : {}),
    ...(workMode ? { workMode } : {}),
    fetchedAt: posting.fetchedAt,
    technical: true,
  };
  return { listing, decision: { externalId: posting.externalId, outcome: 'included', reason: 'source-policy' } };
}

export function processSnapshot(snapshot: SourceSnapshot): ProcessedSnapshot {
  const listings: ProcessedListing[] = [];
  const decisions: PostingDecision[] = [];
  for (const posting of snapshot.postings) {
    const result = processPosting(posting);
    decisions.push(result.decision);
    if (result.listing) listings.push(result.listing);
  }
  const filtered = decisions.filter((decision) => decision.outcome === 'filtered').length;
  const withheld = decisions.filter((decision) => decision.outcome === 'withheld').length;
  return {
    listings,
    decisions,
    counts: {
      raw: snapshot.rawCount,
      valid: snapshot.postings.length,
      eligible: listings.length,
      filtered,
      withheld,
    },
  };
}
