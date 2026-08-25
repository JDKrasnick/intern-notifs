import { catalogSearchText, catalogSourceClasses } from './catalog-fields.js';
import { openCatalogSortKey } from './catalog-recency.js';
import { normalizeInternship, normalizeListing, catalogQualityHash } from './catalog-quality.js';
import { isPastSeason } from './core/early-career.js';
import type { Internship, SourceCheckpoint, SourceOccurrenceState } from './types.js';
import type { D1Database } from '../cloudflare/types.js';

export type CatalogQualityRow = { pk: string; sk: string; kind: string; value: string };
type Category = 'changed' | 'closed' | 'unchanged' | 'unrepairable';
type Field = 'company' | 'title' | 'location' | 'compensation';
type Counts = Record<string, Record<Field, number>>;

export interface CatalogQualityBackfillReport {
  dryRun: boolean;
  before: Counts;
  after: Counts;
  totals: Record<Category, number>;
  samples: Record<Category, string[]>;
  repairToken: string;
  expectedChanged: number;
  conflicts: string[];
  projectionRefreshRequired: boolean;
}

type Repair = { row: CatalogQualityRow; value: Internship | SourceOccurrenceState; category: Category; id: string };

const provider = (sourceId: string) => /^(greenhouse|lever|ashby)-/iu.exec(sourceId)?.[1]?.toLowerCase() ?? 'community';
const emptyCounts = (): Counts => ({});

function qualityFlags(value: Internship | SourceOccurrenceState): Record<Field, boolean> {
  const item = 'occurrence' in value ? value.occurrence : value;
  const normalized = 'occurrence' in value ? normalizeListing(value.occurrence) : normalizeInternship(value);
  return {
    company: item.company !== normalized.company,
    title: item.title !== normalized.title,
    location: item.location !== normalized.location || !item.locations?.length,
    compensation: item.compensation.raw !== normalized.compensation.raw || item.compensation.raw.length > 160,
  };
}

function increment(counts: Counts, source: string, flags: Record<Field, boolean>) {
  const bucket = counts[source] ??= { company: 0, title: 0, location: 0, compensation: 0 };
  for (const key of Object.keys(flags) as Field[]) if (flags[key]) bucket[key] += 1;
}

function explicitElapsedRole(job: Internship, checkpoints: Map<string, SourceCheckpoint>): boolean {
  if (!isPastSeason(job.season)) return true;
  const identity = job.internshipIdentity as { season?: { evidence?: string; evidenceStatus?: string } } | undefined;
  const explicit = identity?.season?.evidence === 'explicit' || identity?.season?.evidenceStatus === 'explicit';
  return Boolean(explicit && job.sourceReferences.some((reference) => {
    if (reference.state !== 'open' || !reference.externalId || !/^(greenhouse|lever|ashby)-/iu.test(reference.sourceId)) return false;
    return checkpoints.get(reference.sourceId)?.activeExternalIds?.includes(reference.externalId);
  }));
}

function repairRows(rows: CatalogQualityRow[]) {
  const checkpoints = new Map<string, SourceCheckpoint>();
  for (const row of rows.filter((item) => item.kind === 'checkpoint')) {
    try {
      const checkpoint = JSON.parse(row.value) as SourceCheckpoint;
      checkpoints.set(checkpoint.sourceId, checkpoint);
    } catch { /* A malformed checkpoint cannot verify an elapsed role. */ }
  }
  const repairs: Repair[] = [];
  const before = emptyCounts(); const after = emptyCounts();
  const totals: Record<Category, number> = { changed: 0, closed: 0, unchanged: 0, unrepairable: 0 };
  const samples: Record<Category, string[]> = { changed: [], closed: [], unchanged: [], unrepairable: [] };
  const sample = (category: Category, id: string) => { if (samples[category].length < 10) samples[category].push(id); };
  for (const row of rows.filter((item) => item.kind === 'internship' || item.kind === 'source-occurrence')) {
    try {
      const current = JSON.parse(row.value) as Internship | SourceOccurrenceState;
      const sourceIds = 'occurrence' in current ? [current.sourceId] : current.sourceReferences.map((item) => item.sourceId);
      const providers = [...new Set(sourceIds.map(provider))];
      for (const name of providers) increment(before, name, qualityFlags(current));
      let proposed: Internship | SourceOccurrenceState;
      let category: Category = 'unchanged';
      const id = 'occurrence' in current ? `${current.sourceId}:${current.externalId}` : current.jobId;
      if ('occurrence' in current) {
        proposed = { ...current, occurrence: normalizeListing(current.occurrence) };
      } else {
        proposed = normalizeInternship(current);
        if (proposed.open && !explicitElapsedRole(proposed, checkpoints)) { proposed = { ...proposed, open: false }; category = 'closed'; }
      }
      for (const name of providers) increment(after, name, qualityFlags(proposed));
      if (category !== 'closed') category = JSON.stringify(proposed) === row.value ? 'unchanged' : 'changed';
      totals[category] += 1; sample(category, id);
      repairs.push({ row, value: proposed, category, id });
    } catch {
      totals.unrepairable += 1;
      sample('unrepairable', `${row.pk}:${row.sk}`);
    }
  }
  return { repairs, before, after, totals, samples };
}

export function catalogQualityBackfillPlan(rows: CatalogQualityRow[]) {
  const plan = repairRows(rows);
  const changed = plan.repairs.filter((item) => item.category === 'changed' || item.category === 'closed');
  const repairToken = catalogQualityHash(changed.map((item) => ({ pk: item.row.pk, sk: item.row.sk, before: catalogQualityHash(item.row.value), after: catalogQualityHash(item.value) })));
  return { ...plan, changed, repairToken };
}

export async function runCatalogQualityBackfill(
  db: D1Database,
  options: { apply?: boolean; repairToken?: string; expectedChanged?: number } = {},
): Promise<CatalogQualityBackfillReport> {
  const result = await db.prepare("SELECT pk, sk, kind, value FROM catalog_items WHERE kind IN ('internship', 'source-occurrence', 'checkpoint') ORDER BY pk, sk").all<CatalogQualityRow>();
  const plan = catalogQualityBackfillPlan(result.results);
  const report: CatalogQualityBackfillReport = {
    dryRun: !options.apply,
    before: plan.before,
    after: plan.after,
    totals: plan.totals,
    samples: plan.samples,
    repairToken: plan.repairToken,
    expectedChanged: plan.changed.length,
    conflicts: [],
    projectionRefreshRequired: false,
  };
  if (!options.apply) return report;
  if (options.repairToken !== plan.repairToken || options.expectedChanged !== plan.changed.length) {
    throw new Error('Catalog changed after dry run; use the latest repair token and exact changed-record count');
  }
  for (const repair of plan.changed) {
    let statement;
    if (repair.row.kind === 'internship') {
      const job = repair.value as Internship;
      statement = db.prepare(`UPDATE catalog_items SET value = ?, url_key = ?, fingerprint_key = ?, sms_pending = ?, digest_pending = ?, catalog_state = ?, catalog_sort_key = ?, search_text = ?, source_classes = ? WHERE pk = ? AND sk = ? AND value = ?`)
        .bind(JSON.stringify(job), job.normalizedUrl, job.fingerprint, job.notification.smsPending ? 1 : 0, job.notification.digestPending ? 1 : 0,
          job.technical === false ? null : job.open ? 'OPEN' : 'CLOSED', job.technical === false ? null : job.open ? openCatalogSortKey(job) : `${job.lastSeenAt}#${job.jobId}`,
          job.technical === false ? null : catalogSearchText(job), job.technical === false ? null : JSON.stringify(catalogSourceClasses(job)),
          repair.row.pk, repair.row.sk, repair.row.value);
    } else {
      statement = db.prepare('UPDATE catalog_items SET value = ? WHERE pk = ? AND sk = ? AND value = ?')
        .bind(JSON.stringify(repair.value), repair.row.pk, repair.row.sk, repair.row.value);
    }
    if ((await statement.run()).meta.changes !== 1) report.conflicts.push(repair.id);
  }
  report.projectionRefreshRequired = report.conflicts.length === 0;
  return report;
}
