const DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Normalize a user-supplied DNS name without accepting URLs, paths, or credentials. */
export function normalizeCompanyDomain(value: string): string | undefined {
  const candidate = value.trim().replace(/\.+$/, '').toLowerCase();
  if (!candidate || candidate.length > 253 || /[@/:?#%[\]\\\s]/.test(candidate)) return undefined;

  let hostname: string;
  try {
    hostname = new URL(`https://${candidate}/`).hostname.replace(/\.+$/, '').toLowerCase();
  } catch {
    return undefined;
  }

  if (hostname !== candidate && !candidate.includes('xn--')) {
    // URL normalizes Unicode domains to their stable ASCII representation.
    return normalizeCompanyDomain(hostname);
  }
  const labels = hostname.split('.');
  if (labels.length < 2 || labels.some((label) => !DOMAIN_LABEL.test(label))) return undefined;
  return hostname;
}

export function normalizedEmailDomain(email: string): string | undefined {
  const candidate = email.trim();
  const separator = candidate.lastIndexOf('@');
  if (separator <= 0 || separator !== candidate.indexOf('@') || separator === candidate.length - 1) return undefined;
  if (/\s/.test(candidate.slice(0, separator))) return undefined;
  return normalizeCompanyDomain(candidate.slice(separator + 1));
}

/** Company-domain verification is intentionally exact; a sibling or subdomain is a separate claim. */
export function emailMatchesCompanyDomain(email: string, claimedDomain: string): boolean {
  const emailDomain = normalizedEmailDomain(email);
  const companyDomain = normalizeCompanyDomain(claimedDomain);
  return emailDomain !== undefined && companyDomain !== undefined && emailDomain === companyDomain;
}
