import { describe, expect, it } from 'vitest';
import {
  applicationUrlMatchesBoard,
  checkEmployerChallenge,
  consumeEmployerChallenge,
  createEmployerChallenge,
  emailMatchesCompanyDomain,
  normalizeCompanyDomain,
  normalizedEmailDomain,
  parseEmployerBoardUrl,
  verifyDnsChallenge,
  verifyWellKnownChallenge,
} from '../src/employer/index.js';

describe('employer domain ownership', () => {
  it('normalizes case, terminal dots, and international domains', () => {
    expect(normalizeCompanyDomain(' Example.COM. ')).toBe('example.com');
    expect(normalizeCompanyDomain('münich.example')).toBe('xn--mnich-kva.example');
    expect(normalizeCompanyDomain('example.com:443')).toBeUndefined();
    expect(normalizedEmailDomain('Owner@EXAMPLE.com.')).toBe('example.com');
  });

  it('requires the verified email to use the exact claimed domain', () => {
    expect(emailMatchesCompanyDomain('owner@example.com', 'EXAMPLE.com.')).toBe(true);
    expect(emailMatchesCompanyDomain('owner@jobs.example.com', 'example.com')).toBe(false);
    expect(emailMatchesCompanyDomain('owner@example.com.attacker.test', 'example.com')).toBe(false);
    expect(emailMatchesCompanyDomain('owner@@example.com', 'example.com')).toBe(false);
    expect(emailMatchesCompanyDomain('owner@gmail.com', 'example.com')).toBe(false);
  });
});

describe('employer challenge state', () => {
  it('returns a random secret while persisting only its hash', async () => {
    const first = await createEmployerChallenge({ now: new Date('2026-08-01T00:00:00Z'), ttlMs: 1_000 });
    const second = await createEmployerChallenge({ now: new Date('2026-08-01T00:00:00Z'), ttlMs: 1_000 });
    expect(first.token).not.toBe(second.token);
    expect(first.token).toHaveLength(43);
    expect(JSON.stringify(first.challenge)).not.toContain(first.token);
    expect(await checkEmployerChallenge(first.challenge, first.token, new Date('2026-08-01T00:00:00.999Z'))).toBe('valid');
    expect(await checkEmployerChallenge(first.challenge, 'wrong', new Date('2026-08-01T00:00:00.999Z'))).toBe('mismatch');
  });

  it('expires at the deadline and prevents replay after consumption', async () => {
    const { token, challenge } = await createEmployerChallenge({ now: new Date('2026-08-01T00:00:00Z'), ttlMs: 1_000 });
    expect(await checkEmployerChallenge(challenge, token, new Date('2026-08-01T00:00:01Z'))).toBe('expired');
    const consumed = consumeEmployerChallenge(challenge, new Date('2026-08-01T00:00:00.500Z'));
    expect(await checkEmployerChallenge(consumed, token, new Date('2026-08-01T00:00:00.600Z'))).toBe('replayed');
    expect(() => consumeEmployerChallenge(consumed)).toThrow(/already/);
  });
});

describe('exact provider board URLs', () => {
  it.each([
    ['https://boards.greenhouse.io/Acme', 'greenhouse', 'Acme'],
    ['https://job-boards.greenhouse.io/acme/', 'greenhouse', 'acme'],
    ['https://job-boards.eu.greenhouse.io/acme', 'greenhouse', 'acme'],
    ['https://jobs.lever.co/acme', 'lever', 'acme'],
    ['https://jobs.ashbyhq.com/acme.ai', 'ashby', 'acme.ai'],
  ] as const)('parses %s without guessing a tenant', (value, provider, tenant) => {
    expect(parseEmployerBoardUrl(value)).toMatchObject({ provider, tenant });
  });

  it.each([
    'http://jobs.lever.co/acme',
    'https://jobs.lever.co/acme/job-id',
    'https://jobs.ashbyhq.com/acme?embed=true',
    'https://acme.jobs.lever.co/',
    'https://jobs.lever.co/acme%2Fother',
    'https://jobs.lever.co/',
  ])('rejects non-board or ambiguous URL %s', (value) => {
    expect(parseEmployerBoardUrl(value)).toBeUndefined();
  });

  it('binds application URLs to the exact provider tenant', () => {
    const lever = parseEmployerBoardUrl('https://jobs.lever.co/acme')!;
    expect(applicationUrlMatchesBoard('https://jobs.lever.co/acme/role-id/apply', lever)).toBe(true);
    expect(applicationUrlMatchesBoard('https://jobs.lever.co/acme-inc/role-id/apply', lever)).toBe(false);
    expect(applicationUrlMatchesBoard('https://jobs.lever.co/Acme/role-id/apply', lever)).toBe(false);
    expect(applicationUrlMatchesBoard('https://jobs.ashbyhq.com/acme/role-id', lever)).toBe(false);
  });
});

describe('domain challenge transports', () => {
  it('joins DNS TXT chunks and requires an exact token', async () => {
    const resolver = { resolveTxt: async () => [['secret-', 'token'], ['unrelated']] };
    await expect(verifyDnsChallenge({ domain: 'example.com', token: 'secret-token', resolver }))
      .resolves.toMatchObject({ verified: true, location: '_internnotifs-verification.example.com' });
    await expect(verifyDnsChallenge({ domain: 'example.com', token: 'secret', resolver }))
      .resolves.toMatchObject({ verified: false });
  });

  it('validates the bounded well-known response on the claimed host', async () => {
    const resolver = { resolve: async () => ['93.184.216.34'] };
    const fetcher = async () => new Response(' secret-token\n', { status: 200 });
    await expect(verifyWellKnownChallenge({ domain: 'example.com', token: 'secret-token', resolver, fetcher }))
      .resolves.toMatchObject({ verified: true });
  });

  it('does not let a well-known redirect delegate proof to another domain', async () => {
    const resolver = { resolve: async () => ['93.184.216.34'] };
    const fetcher = async (input: string | URL | Request) => String(input).includes('example.com')
      ? new Response(null, { status: 302, headers: { location: 'https://attacker.test/proof' } })
      : new Response('secret-token', { status: 200 });
    await expect(verifyWellKnownChallenge({ domain: 'example.com', token: 'secret-token', resolver, fetcher }))
      .resolves.toMatchObject({ verified: false });
  });
});
