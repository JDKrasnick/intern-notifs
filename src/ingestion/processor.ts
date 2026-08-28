import { earlyCareerRequirements, hasLifecycleTitleSignal, htmlToText, inferSeason, inferWorkMode } from '../core/early-career.js';
import { assessTechnicalRole } from '../core/filters.js';
import { parseCompensation } from '../core/normalize.js';
import { isTruncatedTitle, repairTitle } from '../core/role-title.js';
import { buildInternshipIdentity } from '../identity/enrichment.js';
import { canonicalCompanyKey } from '../core/normalize.js';
import { metadataCompleteness } from '../catalog-admission.js';
import { normalizeListing, normalizeLocations, locationSummary } from '../catalog-quality.js';
import { applicationUrlRejection } from '../sources/quality.js';
import { providerPostingReference } from '../identity/posting.js';
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

function destinationProviderReference(applyUrl: string) {
  const reviewed = providerPostingReference(applyUrl);
  if (reviewed.provider !== 'unknown') return reviewed;
  try {
    const url = new URL(applyUrl);
    const greenhouseId = url.searchParams.get('gh_jid');
    if (greenhouseId && /^\d+$/u.test(greenhouseId)) return { provider: 'greenhouse' as const, postingId: greenhouseId };
  } catch { /* Invalid URLs are rejected before this evidence is used. */ }
  return reviewed;
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
  const sourceLocations = posting.locations.map(htmlToText).filter(Boolean);
  const locations = normalizeLocations(sourceLocations);
  const location = locationSummary(locations);
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
  const destinationReference = destinationProviderReference(posting.applyUrl);
  const listing: ProcessedListing = normalizeListing({
    sourceId: posting.sourceId,
    ...(posting.provenance ? { provenance: posting.provenance } : {}),
    externalId: posting.externalId,
    document: posting.document ?? posting.externalId,
    sourceUrl: posting.sourceUrl,
    row: posting.row ?? 1,
    company,
    title,
    location,
    locations,
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
    internshipIdentity: buildInternshipIdentity({
      sourceId: posting.sourceId,
      sourceUrl: posting.sourceUrl,
      observedAt: posting.fetchedAt,
      company,
      companyId: posting.employer.id,
      title,
      location,
      season,
      seasonEvidenceStatus: titleSeason !== 'ongoing' || posting.seasonHintAuthority === 'posting'
        ? 'explicit'
        : season !== 'ongoing' ? 'inferred' : 'unspecified',
      content,
      ...(workMode ? { workMode } : {}),
    }),
    fetchedAt: posting.fetchedAt,
    technical: assessment.technical,
    ...(title === sourceTitle ? {} : { titleRepaired: true }),
    providerIdentity: {
      provider: posting.providerIdentity?.provider
        ?? (destinationReference.provider !== 'unknown' ? destinationReference.provider
          : posting.sourceId.startsWith('greenhouse-') ? 'greenhouse'
          : posting.sourceId.startsWith('lever-') ? 'lever'
            : posting.sourceId.startsWith('ashby-') ? 'ashby'
              : posting.provenance === 'official-structured' ? 'structured'
                : posting.provenance === 'employer-submitted' ? 'employer-submission' : 'github'),
      sourceId: posting.sourceId,
      sourceUrl: posting.sourceUrl,
      employerScope: `employer:${canonicalCompanyKey(company)}`,
      ...(posting.providerIdentity?.tenant ? { tenant: posting.providerIdentity.tenant }
        : destinationReference.tenant ? { tenant: destinationReference.tenant } : {}),
      postingId: destinationReference.postingId ?? posting.externalId,
    },
    employerEvidence: {
      authority: posting.employer.authority,
    },
    metadataCompleteness: metadataCompleteness({
      title: sourceTitle,
      locations: sourceLocations,
      titleRepaired: title !== sourceTitle,
    }),
  });
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
