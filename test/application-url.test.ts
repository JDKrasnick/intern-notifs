import { describe, expect, it } from 'vitest';
import { ApplicationUrlValidationError, validateApplicationUrl } from '../src/core/application-url.js';

describe('application URL validation', () => {
  it('requires HTTPS before making a network request', async () => {
    await expect(validateApplicationUrl('http://careers.example.com/role', async () => {
      throw new Error('must not fetch');
    })).rejects.toThrow(ApplicationUrlValidationError);
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
    expect(methods).toEqual(['HEAD', 'GET']);
  });

  it('rejects broken destinations', async () => {
    await expect(validateApplicationUrl('https://careers.example.com/role', async () =>
      new Response('', { status: 404 }),
    )).rejects.toThrow('HTTP 404');
  });
});
