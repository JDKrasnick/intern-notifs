/**
 * Receiver-safe fetch reference for runtimes such as Cloudflare Workers,
 * where invoking a retained `globalThis.fetch` reference can throw.
 */
export const platformFetch: typeof fetch = (input, init) => globalThis.fetch(input, init);
