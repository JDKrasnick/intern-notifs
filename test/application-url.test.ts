import { describe, expect, it } from 'vitest';
import { ApplicationUrlValidationError, assessApplicationPageForListing, canonicalApplicationUrl, inspectApplicationPage, validateApplicationUrl } from '../src/core/application-url.js';

describe('application URL validation', () => {
  it('canonicalizes TikTok bare position URLs before validation', () => {
    expect(canonicalApplicationUrl('https://lifeattiktok.com/position/7623166667125508357'))
      .toBe('https://lifeattiktok.com/search/7623166667125508357');
    expect(canonicalApplicationUrl('https://lifeattiktok.com/position/7623166667125508357/detail'))
      .toBe('https://lifeattiktok.com/position/7623166667125508357/detail');
  });

  it('requires HTTPS before making a network request', async () => {
    await expect(validateApplicationUrl('http://careers.example.com/role', async () => {
      throw new Error('must not fetch');
    })).rejects.toThrow(ApplicationUrlValidationError);
  });

  it('rejects an aggregator destination before making a network request', async () => {
    let called = false;
    await expect(validateApplicationUrl('https://www.linkedin.com/jobs/123', async () => {
      called = true;
      return new Response('', { status: 200 });
    })).rejects.toThrow('aggregator-only');
    expect(called).toBe(false);
  });

  it('stores the resolved HTTPS destination', async () => {
    const validated = await validateApplicationUrl('https://careers.example.com/role', async () =>
      new Response('', { status: 200 }),
    );
    expect(validated).toBe('https://careers.example.com/role');
  });

  it('retries with GET when a server does not support HEAD', async () => {
    const methods: string[] = [];
    await expect(validateApplicationUrl('https://careers.example.com/role', async (_url, init) => {
      methods.push(String(init?.method));
      return new Response('', { status: methods.length === 1 ? 405 : 200 });
    })).resolves.toBe('https://careers.example.com/role');
    expect(methods).toEqual(['HEAD', 'GET', 'GET']);
  });

  it("reads a rendered job page instead of accepting a generic 200 shell", async () => {
    const id = '7623166667125508357';
    const methods: string[] = [];
    await expect(validateApplicationUrl(`https://lifeattiktok.com/position/${id}`, async (_url, init) => {
      methods.push(String(init?.method));
      return new Response(
        init?.method === 'GET' ? `<title>Machine Learning Engineer Intern</title><main>Job ${id}</main>` : '',
        { status: 200 },
      );
    })).resolves.toBe(`https://lifeattiktok.com/search/${id}`);
    expect(methods).toEqual(['HEAD', 'GET']);
  });

  it("scores a generic shell low even though it returns HTTP 200", async () => {
    await expect(inspectApplicationPage('https://careers.example.com/roles/7623166667125508357', async () =>
      new Response('<title>Join TikTok</title>', { status: 200, headers: { 'content-type': 'text/html' } }),
    )).resolves.toMatchObject({ expectedPostingId: '7623166667125508357', postingIdPresent: false, confidence: { level: 'medium', score: 55, recommendation: 'catalog-only' } });
  });

  it('extracts generic application-page evidence from an ordinary employer host', async () => {
    await expect(inspectApplicationPage('https://careers.example.com/jobs/7623166667125508357', async () =>
      new Response('<title>Software Engineer Intern</title><meta name="description" content="Build platform software.">7623166667125508357', { status: 200, headers: { 'content-type': 'text/html' } }),
    )).resolves.toMatchObject({ title: 'Software Engineer Intern', description: 'Build platform software.', expectedPostingId: '7623166667125508357', postingIdPresent: true, confidence: { level: 'high', score: 100, recommendation: 'alert-eligible' } });
  });
  it('extracts bounded public job content from JSON-LD before generic page text', async () => {
    const description = `<p>${'Build reliable systems with our platform team. '.repeat(12)}Responsibilities include testing and deployment.</p>`;
    const html = `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', description })}</script><main>Navigation text</main>`;
    await expect(inspectApplicationPage('https://careers.example.com/jobs/123456', async () =>
      new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }),
    )).resolves.toMatchObject({ contentExcerpt: expect.stringContaining('Responsibilities include testing'), contentSource: 'json-ld', confidence: { signals: expect.arrayContaining(['substantive page content', 'job-description language']) } });
  });
  it('caps a generic career shell at catalog-only even when its metadata is present', async () => {
    await expect(inspectApplicationPage('https://careers.example.com/jobs/123456', async () =>
      new Response('<title>JPMC Candidate Experience page</title><meta name="description" content="Search opportunities.">', { status: 200, headers: { 'content-type': 'text/html' } }),
    )).resolves.toMatchObject({ confidence: { level: 'medium', score: 65, recommendation: 'catalog-only', signals: expect.arrayContaining(['generic career-page title']) } });
  });
  it('promotes substantive public job text that matches the source role', async () => {
    const html = `<meta name="description" content="Apply for this role."><main>${'Software Engineering Intern. '.repeat(20)}Responsibilities include testing distributed systems.</main>`;
    const evidence = await inspectApplicationPage('https://careers.example.com/jobs/workday-role', async () =>
      new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }),
    );
    expect(evidence.confidence).toMatchObject({ level: 'medium', score: 65 });
    expect(assessApplicationPageForListing('Software Engineer Intern', evidence)).toMatchObject({ level: 'high', score: 75, recommendation: 'alert-eligible', signals: expect.arrayContaining(['source role matches public job content']) });
  });
  it('treats bot protection as unverified rather than a dead link', async () => {
    await expect(inspectApplicationPage('https://careers.example.com/jobs/123456', async () =>
      new Response('Access denied', { status: 403 }),
    )).resolves.toMatchObject({ confidence: { level: 'low', recommendation: 'review', signals: expect.arrayContaining(['access restricted to scraper']) } });
  });
  it('treats a server failure as transient rather than a dead link', async () => {
    await expect(inspectApplicationPage('https://careers.example.com/jobs/123456', async () =>
      new Response('Service unavailable', { status: 503 }),
    )).resolves.toMatchObject({ confidence: { level: 'low', recommendation: 'review', signals: expect.arrayContaining(['temporary server failure']) } });
  });
  it('rejects a successful response that resolves to an explicit error URL', async () => {
    const response = new Response('', { status: 200, headers: { 'content-type': 'text/html' } });
    Object.defineProperty(response, 'url', { value: 'https://careers.example.com/errorpage/?errortype=404' });
    await expect(inspectApplicationPage('https://careers.example.com/jobs/123456', async () => response)).rejects.toThrow('explicit error destination');
  });

  it('rejects broken destinations', async () => {
    await expect(validateApplicationUrl('https://careers.example.com/role', async () =>
      new Response('', { status: 404 }),
    )).rejects.toThrow('HTTP 404');
  });
});
