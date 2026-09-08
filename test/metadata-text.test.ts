import { describe, expect, it } from 'vitest';
import { metadataDescriptionText } from '../src/core/metadata-text.js';

describe('employer metadata text boundaries', () => {
  it('preserves nested list rows and inline wording', () => {
    expect(metadataDescriptionText('<h3>Compensation</h3><ul><li>Rates:<ul><li>Undergraduate: <b>$30</b>/hour</li><li>PhD: $35/hour</li></ul></li></ul>'))
      .toBe('Compensation\nRates:\nUndergraduate: $30 /hour\nPhD: $35/hour');
  });
  it('decodes bounded nested entities and excludes executable content', () => {
    expect(metadataDescriptionText('&lt;p&gt;$90,000 &amp;mdash; $110,000 USD&lt;/p&gt;<script>Salary $999/hour</script><style>.pay {}</style>'))
      .toBe('$90,000 — $110,000 USD');
    expect(metadataDescriptionText('&#x110000; &#55296; &#0; &#x24;40&nbsp;/hour')).toBe('&#x110000; &#55296; &#0; $40 /hour');
    expect(metadataDescriptionText('&amp;amp;amp;amp;')).toBe('&amp;');
  });
});
