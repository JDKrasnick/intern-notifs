export type EmployerBoardProvider = 'greenhouse' | 'lever' | 'ashby';

export interface EmployerBoardIdentity {
  provider: EmployerBoardProvider;
  tenant: string;
  boardUrl: string;
}

const PROVIDER_BY_HOST: Readonly<Record<string, EmployerBoardProvider>> = {
  'boards.greenhouse.io': 'greenhouse',
  'job-boards.greenhouse.io': 'greenhouse',
  'job-boards.eu.greenhouse.io': 'greenhouse',
  'jobs.lever.co': 'lever',
  'jobs.ashbyhq.com': 'ashby',
};

/** Parse only a provider's exact board root. Job URLs and inferred company slugs are rejected. */
export function parseEmployerBoardUrl(value: string): EmployerBoardIdentity | undefined {
  let url: URL;
  try { url = new URL(value); } catch { return undefined; }
  const host = url.hostname.toLowerCase();
  const provider = PROVIDER_BY_HOST[host];
  if (!provider || url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash) {
    return undefined;
  }
  const match = /^\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})\/?$/.exec(url.pathname);
  if (!match) return undefined;
  const tenant = match[1]!;
  return { provider, tenant, boardUrl: `https://${host}/${tenant}` };
}

/** Require an application URL to stay inside the connected provider and exact tenant. */
export function applicationUrlMatchesBoard(value: string, board: EmployerBoardIdentity): boolean {
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
  const host = url.hostname.toLowerCase();
  const expectedHosts: Readonly<Record<EmployerBoardProvider, readonly string[]>> = {
    greenhouse: ['boards.greenhouse.io', 'job-boards.greenhouse.io', 'job-boards.eu.greenhouse.io'],
    lever: ['jobs.lever.co'],
    ashby: ['jobs.ashbyhq.com'],
  };
  if (!expectedHosts[board.provider].includes(host)) return false;
  const escapedTenant = board.tenant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pathContracts: Readonly<Record<EmployerBoardProvider, RegExp>> = {
    greenhouse: new RegExp(`^/${escapedTenant}/jobs/[^/]+(?:/.*)?$`),
    lever: new RegExp(`^/${escapedTenant}/[^/]+(?:/apply)?/?$`),
    ashby: new RegExp(`^/${escapedTenant}/[^/]+(?:/application)?/?$`),
  };
  return pathContracts[board.provider].test(url.pathname);
}
