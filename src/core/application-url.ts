const requestHeaders = {
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'User-Agent': 'InternNotifs link verifier/1.0',
};

export class ApplicationUrlValidationError extends Error {}

export type ApplicationUrlValidator = (url: string) => Promise<string>;

function httpsUrl(value: string, label: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new ApplicationUrlValidationError(`${label} is not a URL`);
  }
  if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password) {
    throw new ApplicationUrlValidationError(`${label} must be an HTTPS URL`);
  }
  return parsed;
}

/**
 * Confirms an official application URL resolves before it reaches the catalog
 * or an alert. The GET fallback covers career sites that reject or do not
 * implement HEAD requests.
 */
export async function validateApplicationUrl(
  value: string,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  const sourceUrl = httpsUrl(value, 'Application link');
  const request = async (method: 'HEAD' | 'GET') =>
    fetcher(sourceUrl, {
      method,
      redirect: 'follow',
      headers: method === 'GET' ? { ...requestHeaders, Range: 'bytes=0-0' } : requestHeaders,
      signal: AbortSignal.timeout(8_000),
    });

  let response: Response;
  try {
    response = await request('HEAD');
    if (!response.ok) response = await request('GET');
  } catch (error) {
    const detail = error instanceof Error && error.name === 'TimeoutError'
      ? 'timed out'
      : 'could not be reached';
    throw new ApplicationUrlValidationError(`Application link ${detail}`);
  }

  if (!response.ok) {
    throw new ApplicationUrlValidationError(`Application link returned HTTP ${response.status}`);
  }

  return httpsUrl(response.url || sourceUrl.toString(), 'Resolved application link').toString();
}
