import { describe, expect, it } from 'vitest';
import { gmailMessageContent } from '../src/gmail-content.js';

function encoded(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/gu, '');
}

describe('Gmail message content extraction', () => {
  it('prefers plain text and decodes unpadded base64url', () => {
    expect(gmailMessageContent({
      mimeType: 'multipart/alternative',
      parts: [
        { mimeType: 'text/plain', body: { data: encoded('Application received — Northstar Labs') } },
        { mimeType: 'text/html', body: { data: encoded('<p>HTML fallback</p>') } },
      ],
    })).toBe('Application received — Northstar Labs');
  });

  it('falls back to readable HTML and removes scripts', () => {
    expect(gmailMessageContent({
      mimeType: 'text/html',
      body: { data: encoded('<style>hidden</style><p>Thank you &amp; welcome</p><script>ignored()</script>') },
    })).toBe('Thank you & welcome');
  });

  it('uses HTML when an alternative plain-text part is empty', () => {
    expect(gmailMessageContent({
      mimeType: 'multipart/alternative',
      parts: [
        { mimeType: 'text/plain', body: { data: encoded('  ') } },
        { mimeType: 'text/html', body: { data: encoded('<p>Application received</p>') } },
      ],
    })).toBe('Application received');
  });

  it('does not extract attachments and falls back to the Gmail snippet', () => {
    expect(gmailMessageContent({
      mimeType: 'text/plain', filename: 'confirmation.txt',
      body: { data: encoded('secret attachment text'), attachmentId: 'attachment-1' },
    }, 'Safe snippet')).toBe('Safe snippet');
  });

  it('bounds the transient text returned to the matcher', () => {
    const content = gmailMessageContent({ mimeType: 'text/plain', body: { data: encoded('a'.repeat(30_000)) } });
    expect(content.length).toBeLessThanOrEqual(16_384);
  });
});
