/** Keep employer paragraph/list boundaries while decoding transient descriptions.
 * Flattening the whole page transfers one salary row's labels to every amount.
 * This is text extraction, never HTML rendering. */
export function metadataDescriptionText(value: string): string {
  const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—' };
  let decoded = value;
  for (let pass = 0; pass < 3; pass += 1) {
    const next = decoded.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp|ndash|mdash);/giu, (original, code: string) => {
      if (!code.startsWith('#')) return entities[code.toLowerCase()] ?? original;
      const point = code[1]?.toLowerCase() === 'x' ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1), 10);
      return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : original;
    });
    if (next === decoded) break;
    decoded = next;
  }
  return decoded.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, ' ')
    .replace(/<\/?(?:p|div|li|ul|ol|h[1-6]|tr|section|article|dl|dt|dd|br)\b[^>]*>/giu, '\n')
    .replace(/<[^>]+>/gu, ' ').split(/[\r\n]+/u).map(line => line.replace(/\s+/gu, ' ').trim()).filter(Boolean).join('\n');
}
