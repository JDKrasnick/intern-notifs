import { createHash } from 'node:crypto';
import { inferJobFocuses } from './core/filters.js';
import { catalogSourceClasses, type CatalogSource } from './catalog-fields.js';
import { catalogVisibleAt, compareCatalogRecency } from './catalog-recency.js';
import type { Internship } from './types.js';

export type CatalogGroupKind = 'program-group' | 'employer-release' | 'individual';
export type EducationEvidence = 'explicit' | 'inferred' | 'unspecified' | 'conflicting';

export interface CatalogEducationSummary {
  levels: string[];
  evidence: EducationEvidence;
  label: string;
}

export interface CatalogGroupRow {
  groupId: string;
  kind: CatalogGroupKind;
  company: string;
  seasons: string[];
  education: CatalogEducationSummary[];
  roleCount: number;
  titles: string[];
  disciplines: string[];
  locations: string[];
  workModes: string[];
  createdAt: string;
  updatedAt: string;
  hasNewRoles: boolean;
  roleIds: string[];
}

export interface CatalogGroupDetails {
  group: CatalogGroupRow;
  roles: CatalogGroupRole[];
}

export interface CatalogGroupRole {
  jobId: string;
  company: string;
  title: string;
  location: string;
  season: string;
  education: CatalogEducationSummary;
  disciplines: string[];
  workModes: string[];
  sourceCredibility: 'official' | 'corroborated' | 'community' | 'unspecified';
  detailUrl: string;
  officialApplyUrl: string;
  applicationUrlValidated: boolean;
  open: boolean;
}

export interface CatalogGroupFilter {
  query?: string;
  source?: CatalogSource;
  disciplines?: string[];
  seasons?: string[];
  educationLevels?: string[];
  workModes?: string[];
  locations?: string[];
}

/** A durable release already contains the job set matched for one user. */
export interface CatalogRelease {
  releaseId: string;
  userId: string;
  jobIds: string[];
  newJobIds: string[];
  createdAt: string;
}

type StructuredIdentity = {
  canonicalCompanyId?: string;
  canonicalCompanyName?: string;
  company?: { canonicalId?: string; id?: string; displayName?: string | { value?: string } };
  season?: string | { term?: string; year?: number | string; evidence?: string };
  educationAudience?: {
    levels?: string[];
    evidence?: string;
    evidenceStatus?: string;
  };
  education?: {
    levels?: string[];
    evidence?: string;
    evidenceStatus?: string;
  };
  title?: { official?: string | { value?: string }; display?: string | { value?: string } };
  disciplineTags?: Array<string | { value?: string }>;
  disciplines?: Array<string | { value?: string }>;
  locations?: Array<string | { name?: string; displayName?: string; workMode?: string }>;
  workModes?: string[];
};

type CatalogJob = Internship & { internshipIdentity?: StructuredIdentity; identity?: StructuredIdentity };
type BuiltGroup = { row: CatalogGroupRow; jobs: Internship[] };

const RELEASE_WINDOW_MS = 8_000;
const compact = (value: string) => value.trim().replace(/\s+/g, ' ');
const folded = (value: string) => compact(value).toLocaleLowerCase('en-US');
const unique = (values: string[]) => [...new Map(values.filter(Boolean).map((value) => [folded(value), compact(value)])).values()];
const timestamp = (job: Internship) => Date.parse(catalogVisibleAt(job));
const identityFor = (job: Internship) => (job as CatalogJob).internshipIdentity ?? (job as CatalogJob).identity;

function companyKey(job: Internship) {
  const identity = identityFor(job);
  const value = identity?.canonicalCompanyId ?? identity?.company?.canonicalId ?? identity?.company?.id ?? job.company;
  return compact(value) ? folded(value) : undefined;
}

function provenancedText(value: string | { value?: string } | undefined) {
  return typeof value === 'string' ? value : value?.value;
}

function titleFor(job: Internship) {
  const title = identityFor(job)?.title;
  return compact(provenancedText(title?.display) ?? provenancedText(title?.official) ?? job.title);
}

function seasonFor(job: Internship) {
  const season = identityFor(job)?.season;
  if (typeof season === 'string') return compact(season);
  if (season?.term && season.year) return `${compact(season.term)}-${season.year}`;
  return compact(job.season);
}

function evidence(value: string | undefined): EducationEvidence {
  return value === 'explicit' || value === 'inferred' || value === 'conflicting' ? value : 'unspecified';
}

export function catalogEducation(job: Internship): CatalogEducationSummary {
  const identity = identityFor(job);
  const audience = identity?.educationAudience ?? identity?.education;
  const levels = unique(audience?.levels ?? []).sort((left, right) => left.localeCompare(right));
  const status = evidence(audience?.evidenceStatus ?? audience?.evidence);
  if (status === 'conflicting') return { levels, evidence: status, label: 'Education requirements conflict across sources' };
  if (status === 'unspecified' || levels.length === 0) {
    return { levels: [], evidence: 'unspecified', label: 'Education level not specified by employer' };
  }
  return { levels, evidence: status, label: levels.join(' + ') };
}

function safeProgramKey(job: Internship) {
  const company = companyKey(job);
  const season = seasonFor(job);
  const education = catalogEducation(job);
  if (!company || !season || education.evidence === 'conflicting') return undefined;
  return `${company}\u0000${folded(season)}\u0000${education.evidence}\u0000${education.levels.map(folded).sort().join(',')}`;
}

function locationsFor(job: Internship) {
  const structured = identityFor(job)?.locations?.map((location) => typeof location === 'string' ? location : location.displayName ?? location.name ?? '') ?? [];
  return unique(structured.length ? structured : job.location.split(/\s*(?:;|\||\n)\s*/));
}

function workModesFor(job: Internship) {
  const identity = identityFor(job);
  const sourceModes = job.sourceReferences.map((reference) => reference.workMode ?? '').filter(Boolean);
  const locationModes = identity?.locations?.map((location) => typeof location === 'string' ? '' : location.workMode ?? '').filter(Boolean) ?? [];
  const declared = identity?.workModes ?? (locationModes.length ? locationModes : sourceModes);
  if (declared.length) return unique(declared);
  const text = `${job.location} ${job.title}`;
  return [/\bremote\b/i.test(text) ? 'remote' : '', /\bhybrid\b/i.test(text) ? 'hybrid' : '', /\b(?:on.?site|in.?person)\b/i.test(text) ? 'onsite' : ''].filter(Boolean);
}

function disciplinesFor(job: Internship) {
  const identity = identityFor(job);
  const structured = identity?.disciplineTags ?? identity?.disciplines;
  return unique(structured?.map((item) => typeof item === 'string' ? item : item.value ?? '').filter(Boolean) ?? inferJobFocuses(job));
}

function groupId(kind: CatalogGroupKind, jobs: Internship[]) {
  const chronological = [...jobs].sort((left, right) => timestamp(left) - timestamp(right));
  const stable = kind === 'program-group'
    ? safeProgramKey(chronological[0]!) ?? chronological[0]!.jobId
    : kind === 'employer-release'
      ? `${companyKey(chronological[0]!) ?? chronological[0]!.company}\u0000${catalogVisibleAt(chronological[0]!)}`
      : chronological[0]!.jobId;
  return `${kind}-${createHash('sha256').update(stable).digest('base64url').slice(0, 20)}`;
}

function summarize(kind: CatalogGroupKind, jobs: Internship[], stableGroupId?: string): CatalogGroupRow {
  const sorted = [...jobs].sort(compareCatalogRecency);
  const createdAt = sorted.reduce((oldest, job) => catalogVisibleAt(job) < oldest ? catalogVisibleAt(job) : oldest, catalogVisibleAt(sorted[0]!));
  const updatedAt = catalogVisibleAt(sorted[0]!);
  const company = identityFor(sorted[0]!)?.canonicalCompanyName ?? provenancedText(identityFor(sorted[0]!)?.company?.displayName) ?? sorted[0]!.company;
  return {
    groupId: stableGroupId ?? groupId(kind, sorted), kind, company,
    seasons: unique(sorted.map(seasonFor)),
    education: unique(sorted.map((job) => JSON.stringify(catalogEducation(job)))).map((item) => JSON.parse(item) as CatalogEducationSummary),
    roleCount: sorted.length,
    titles: unique(sorted.map(titleFor)).slice(0, 3),
    disciplines: unique(sorted.flatMap(disciplinesFor)).slice(0, 6),
    locations: unique(sorted.flatMap(locationsFor)),
    workModes: unique(sorted.flatMap(workModesFor)),
    createdAt, updatedAt, hasNewRoles: updatedAt !== createdAt,
    roleIds: sorted.map((job) => job.jobId),
  };
}

function burstGroups(jobs: Internship[]) {
  const releases: Internship[][] = [];
  const remaining = new Set(jobs);
  const byCompany = new Map<string, Internship[]>();
  for (const job of jobs) {
    const key = companyKey(job);
    if (!key || !Number.isFinite(timestamp(job))) continue;
    const matches = byCompany.get(key) ?? [];
    matches.push(job); byCompany.set(key, matches);
  }
  for (const companyJobs of byCompany.values()) {
    const ordered = companyJobs.sort((left, right) => timestamp(left) - timestamp(right));
    for (let index = 0; index < ordered.length;) {
      const anchor = timestamp(ordered[index]!);
      let end = index + 1;
      while (end < ordered.length && timestamp(ordered[end]!) - anchor <= RELEASE_WINDOW_MS) end += 1;
      const burst = ordered.slice(index, end).filter((job) => remaining.has(job));
      if (burst.length >= 4) {
        releases.push(burst);
        burst.forEach((job) => remaining.delete(job));
        index = end;
      } else index += 1;
    }
  }
  return { releases, remaining: [...remaining] };
}

/** Deterministically builds safe catalog rows without treating title/location similarity as posting identity. */
export function groupCatalogJobs(jobs: Internship[], options: { includeClosed?: boolean } = {}): BuiltGroup[] {
  const visible = jobs.filter((job) => (options.includeClosed || job.open) && job.technical !== false);
  const { releases, remaining } = burstGroups(visible);
  const grouped: Internship[][] = [];
  const unsafe: Internship[] = [];
  const programs = new Map<string, Internship[]>();
  for (const job of remaining) {
    const key = safeProgramKey(job);
    if (!key) { unsafe.push(job); continue; }
    const matches = programs.get(key) ?? [];
    matches.push(job); programs.set(key, matches);
  }
  grouped.push(...programs.values());
  return [
    ...releases.map((roles) => ({ row: summarize('employer-release', roles), jobs: roles })),
    ...grouped.map((roles) => ({ row: summarize(roles.length > 1 ? 'program-group' : 'individual', roles), jobs: roles })),
    ...unsafe.map((job) => ({ row: summarize('individual', [job]), jobs: [job] })),
  ].sort((left, right) => right.row.updatedAt.localeCompare(left.row.updatedAt));
}

function sourceCredibility(job: Internship): CatalogGroupRole['sourceCredibility'] {
  const classes = catalogSourceClasses(job);
  if (classes.includes('corroborated')) return 'corroborated';
  if (classes.includes('direct')) return 'official';
  if (classes.includes('community')) return 'community';
  return 'unspecified';
}

export function catalogGroupDetails(group: BuiltGroup): CatalogGroupDetails {
  return {
    group: group.row,
    roles: [...group.jobs].sort(compareCatalogRecency).map((job) => ({
      jobId: job.jobId, company: job.company, title: titleFor(job), location: job.location, season: seasonFor(job),
      education: catalogEducation(job), disciplines: disciplinesFor(job), workModes: workModesFor(job),
      sourceCredibility: sourceCredibility(job), detailUrl: `/jobs/${encodeURIComponent(job.jobId)}`,
      officialApplyUrl: job.applyUrl, applicationUrlValidated: Boolean(job.applicationUrlValidatedAt), open: job.open,
    })),
  };
}

function includesFolded(values: string[], requested: string[]) {
  const available = values.map(folded);
  return requested.some((value) => available.includes(folded(value)));
}

export function filterCatalogGroups(groups: BuiltGroup[], filter: CatalogGroupFilter): BuiltGroup[] {
  const query = folded(filter.query ?? '');
  return groups.flatMap((group) => {
    const jobs = group.jobs.filter((job) => {
      const education = catalogEducation(job);
      return (!query || folded(`${job.company} ${titleFor(job)} ${job.location} ${seasonFor(job)}`).includes(query))
        && (!filter.source || filter.source === 'all' || catalogSourceClasses(job).includes(filter.source))
        && (!filter.disciplines?.length || includesFolded(disciplinesFor(job), filter.disciplines))
        && (!filter.seasons?.length || includesFolded([seasonFor(job)], filter.seasons))
        // Unspecified education matches every audience but remains visibly unspecified.
        && (!filter.educationLevels?.length || education.evidence === 'unspecified' || includesFolded(education.levels, filter.educationLevels))
        && (!filter.workModes?.length || includesFolded(workModesFor(job), filter.workModes))
        && (!filter.locations?.length || filter.locations.some((location) => folded(locationsFor(job).join(' ')).includes(folded(location))));
    });
    return jobs.length ? [{ row: summarize(group.row.kind, jobs, group.row.groupId), jobs }] : [];
  });
}
