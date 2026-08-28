const maxContentCharacters = 16_384;
const maxEncodedCharacters = 24_576;
const maxMimeParts = 64;
const maxMimeDepth = 12;

export interface GmailMessagePart {
  mimeType?: string;
  filename?: string;
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: GmailMessagePart[];
}

function decodeBase64Url(value: string): string {
  const bounded = value.length > maxEncodedCharacters ? value.slice(0, maxEncodedCharacters) : value;
  const padded = bounded.replace(/-/gu, '+').replace(/_/gu, '/').padEnd(Math.ceil(bounded.length / 4) * 4, '=');
  try {
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return '';
  }
}

function plainTextFromHtml(value: string): string {
  return value
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, ' ')
    .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>/giu, '\n')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/&nbsp;|&#160;/giu, ' ')
    .replace(/&amp;/giu, '&')
    .replace(/&lt;/giu, '<')
    .replace(/&gt;/giu, '>')
    .replace(/&quot;/giu, '"')
    .replace(/&#39;|&apos;/giu, "'");
}

function collect(part: GmailMessagePart | undefined, plain: string[], html: string[], state: { visited: number }, depth = 0): void {
  if (!part || depth > maxMimeDepth || state.visited >= maxMimeParts) return;
  state.visited += 1;
  const attachment = Boolean(part.filename || part.body?.attachmentId);
  if (!attachment && part.body?.data) {
    const decoded = decodeBase64Url(part.body.data);
    if (decoded.trim() && part.mimeType?.toLowerCase() === 'text/plain') plain.push(decoded);
    else if (decoded.trim() && part.mimeType?.toLowerCase() === 'text/html') html.push(decoded);
  }
  for (const child of part.parts ?? []) collect(child, plain, html, state, depth + 1);
}

/** Extract a bounded transient text view without retaining attachments or raw MIME. */
export function gmailMessageContent(payload: GmailMessagePart | undefined, snippet = ''): string {
  const plain: string[] = []; const html: string[] = [];
  collect(payload, plain, html, { visited: 0 });
  const selected = plain.length ? plain.join('\n') : html.map(plainTextFromHtml).join('\n');
  return (selected || snippet).replace(/\s+/gu, ' ').trim().slice(0, maxContentCharacters);
}
