import { describe, expect, it } from 'vitest';
import { probeLeverCandidate } from '../src/sources/lever-probe.js';
import { publishedLeverSources } from '../src/sources/lever-config.js';
import { admissibleLeverEvidence, type LeverOwnershipEvidence } from '../src/sources/lever-evidence.js';
import { LEVER_EVIDENCE_ROOT } from '../src/sources/lever-manifest.js';
import { existsSync, readFileSync } from 'node:fs';

// Network-dependent, so it is opt-in and off by default. Run it with
// `npm run test:lever:live`, which sets LEVER_LIVE=1. It reads the public
// Postings API and nothing else.
const enabled = process.env.LEVER_LIVE === '1';

describe.skipIf(!enabled)('lever live contract', () => {
  it('keeps every published board live and inside its URL contract', async () => {
    for (const source of publishedLeverSources()) {
      const result = await probeLeverCandidate(source.site);
      if (result.state === 'transport-error') continue;
      expect(result.state, `${source.id} probe state`).toBe('ok');
      if (result.state !== 'ok') continue;
      expect(result.urlContractViolations, `${source.id} URL-contract violations`).toBe(0);
      for (const host of Object.keys(result.applicationHostSummary)) {
        expect(host, `${source.id} application host`).toBe('jobs.lever.co');
      }
    }
  }, 120_000);

  it('still finds the recorded ownership evidence on the employer page', async () => {
    for (const source of publishedLeverSources()) {
      const path = `${LEVER_EVIDENCE_ROOT}/${source.site}/evidence.json`;
      if (!existsSync(path)) continue;
      const evidence = JSON.parse(readFileSync(path, 'utf8')) as LeverOwnershipEvidence;
      expect(admissibleLeverEvidence(evidence), `${source.site} recorded evidence`).toBe(true);
      const response = await fetch(evidence.firstPartyEvidenceUrl, { redirect: 'follow' });
      expect(response.ok, `${evidence.firstPartyEvidenceUrl} fetch`).toBe(true);
      // Ownership decays. If the employer's page no longer names the site, the
      // board belongs in shadow until a person looks.
      expect(await response.text(), `${evidence.firstPartyEvidenceUrl} still links the board`)
        .toContain(`jobs.lever.co/${evidence.site}`);
    }
  }, 120_000);
});
