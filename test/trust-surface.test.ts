import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { currentPrivacyVersion as backendPrivacyVersion, currentTermsVersion as backendTermsVersion } from '../cloudflare/auth.js';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const readMobilePolicyVersion = (name: 'currentPrivacyVersion' | 'currentTermsVersion') => {
  const match = read('mobile/src/policies.ts').match(new RegExp(`export const ${name} = '([^']+)';`, 'u'));
  if (!match) throw new Error(`Missing ${name} in mobile/src/policies.ts`);
  return match[1];
};

describe('public trust surface', () => {
  it('keeps signup policy versions synchronized', () => {
    expect(readMobilePolicyVersion('currentTermsVersion')).toBe(backendTermsVersion);
    expect(readMobilePolicyVersion('currentPrivacyVersion')).toBe(backendPrivacyVersion);
  });

  it('publishes every required policy from the public index', () => {
    const index = read('docs/index.html');
    for (const page of ['privacy.html', 'terms.html', 'retention.html', 'source-policy.html', 'support.html']) {
      expect(index).toContain(`href="${page}"`);
      expect(read(`docs/${page}`)).toContain('JD Krasnick');
    }
  });

  it('keeps private account requests off the public issue tracker', () => {
    const support = read('docs/support.html');
    expect(support).toContain('id="delete-account"');
    expect(support).toContain('mailto:onlinestuff309@gmail.com');
    expect(support).toContain('Do not include passwords, account email addresses');
  });

  it('declares collected iOS data and no tracking', () => {
    const manifest = read('mobile/ios/InternNotifs/PrivacyInfo.xcprivacy');
    expect(manifest).toContain('NSPrivacyCollectedDataTypeEmailAddress');
    expect(manifest).toContain('NSPrivacyCollectedDataTypeDeviceID');
    expect(manifest).toMatch(/<key>NSPrivacyTracking<\/key>\s*<false\/>/u);
  });
});
