export type FilterMatchReason = {
  kind: 'category' | 'keyword' | 'company-type' | 'default-all-technical';
  label: string;
};

export type JobNotificationData = {
  destination?: unknown;
  jobId?: unknown;
  applicationId?: unknown;
  url?: unknown;
  matchedFilters?: unknown;
};

export type AppDestination =
  | { kind: 'job'; jobId: string; reasons: FilterMatchReason[]; exclusionsApplied: boolean }
  | { kind: 'saved' };

function filterContext(value: unknown) {
  if (!value || typeof value !== 'object') return { reasons: [], exclusionsApplied: false };
  const context = value as { reasons?: unknown; exclusionsApplied?: unknown };
  const reasons = Array.isArray(context.reasons)
    ? context.reasons.filter((reason): reason is FilterMatchReason => {
      if (!reason || typeof reason !== 'object') return false;
      const value = reason as { kind?: unknown; label?: unknown };
      return ['category', 'keyword', 'company-type', 'default-all-technical'].includes(String(value.kind))
        && typeof value.label === 'string' && value.label.trim().length > 0;
    })
    : [];
  return { reasons, exclusionsApplied: context.exclusionsApplied === true };
}

export function destinationFromNotification(data: JobNotificationData): AppDestination | undefined {
  if (typeof data.applicationId === 'string' || data.destination === 'saved') return { kind: 'saved' };
  if (typeof data.jobId !== 'string' || !data.jobId) return undefined;
  return { kind: 'job', jobId: data.jobId, ...filterContext(data.matchedFilters) };
}

export function destinationFromUrl(url: string): AppDestination | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'internnotifs:' || parsed.hostname !== 'jobs') return undefined;
    const encodedId = parsed.pathname.replace(/^\//, '').split('/')[0];
    if (!encodedId) return undefined;
    return { kind: 'job', jobId: decodeURIComponent(encodedId), reasons: [], exclusionsApplied: false };
  } catch {
    return undefined;
  }
}

export function jobDeepLink(jobId: string) {
  return `internnotifs://jobs/${encodeURIComponent(jobId)}`;
}

export function isDuplicateJobOpen(activeJobId: string | undefined, nextJobId: string) {
  return activeJobId === nextJobId;
}

type SourceReference = { sourceId: string; sourceUrl?: string };
const officialProvider = (sourceId: string) => {
  const normalized = sourceId.toLowerCase();
  if (normalized.startsWith('greenhouse-')) return 'Greenhouse';
  if (normalized.startsWith('lever-')) return 'Lever';
  if (normalized.startsWith('ashby-')) return 'Ashby';
  return undefined;
};

export function sourcePresentation(references: SourceReference[]) {
  const official = [...new Set(references.map((reference) => officialProvider(reference.sourceId)).filter((provider): provider is NonNullable<ReturnType<typeof officialProvider>> => Boolean(provider)))];
  const hasCommunity = references.some((reference) => /^github-/i.test(reference.sourceId)
    || /(?:^|\/\/)(?:raw\.)?github(?:usercontent)?\.com(?:[/:]|$)/i.test(reference.sourceUrl ?? ''));
  return {
    primary: official.length ? `Official employer source · ${official.join(' + ')}` : 'Community listing',
    corroboration: official.length && hasCommunity ? 'Also corroborated by a community listing' : undefined,
  };
}

export function freshnessLabel(lastSeenAt: string, now = new Date()) {
  const date = new Date(lastSeenAt);
  if (Number.isNaN(date.valueOf())) return 'Confirmation time unavailable';
  const elapsedDays = Math.max(0, Math.floor((now.valueOf() - date.valueOf()) / 86_400_000));
  if (elapsedDays === 0) return 'Confirmed today';
  if (elapsedDays === 1) return 'Confirmed yesterday';
  if (elapsedDays < 7) return `Confirmed ${elapsedDays} days ago`;
  return `Confirmed ${new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(date)}`;
}

export function isNewJob(firstSeenAt: string, options: { signedIn: boolean; previousCatalogOpenedAt?: string | null; now?: Date }) {
  const discovered = new Date(firstSeenAt).valueOf();
  if (Number.isNaN(discovered)) return false;
  if (options.signedIn && options.previousCatalogOpenedAt) {
    const previous = new Date(options.previousCatalogOpenedAt).valueOf();
    return !Number.isNaN(previous) && discovered > previous;
  }
  const now = options.now?.valueOf() ?? Date.now();
  return discovered > now - 72 * 60 * 60 * 1000 && discovered <= now;
}

export function validatedOfficialUrl(job: { applyUrl: string; applicationUrlValidatedAt?: string; invalidApplicationUrl?: string }) {
  return /^https:\/\//i.test(job.applyUrl) && Boolean(job.applicationUrlValidatedAt) && job.invalidApplicationUrl !== job.applyUrl
    ? job.applyUrl
    : undefined;
}

export function routeFailureState(error: unknown): 'missing' | 'error' {
  return error instanceof Error && /not found/i.test(error.message) ? 'missing' : 'error';
}
