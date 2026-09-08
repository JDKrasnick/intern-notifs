import { describe, expect, it } from 'vitest';
import {
  catalogProviderDefinitions,
  catalogProviderForSourceId,
  catalogProviderIds,
  integrationRegistry,
  type ProviderWorkflow,
  type SourceAction,
} from '../src/integration-registry.js';

const supportedActions = new Set<SourceAction>([
  'pause', 'resume', 'replay', 'quarantine', 'recover', 'acknowledge', 'resolve', 'set-tier',
]);
const supportedWorkflows = new Set<ProviderWorkflow>(['candidate-review']);

describe('catalog provider integration registry', () => {
  it('keeps stable unique provider identities and valid regional defaults', () => {
    expect(catalogProviderIds).toEqual(['greenhouse', 'lever', 'ashby', 'github']);
    expect(new Set(catalogProviderDefinitions.map((provider) => provider.id)).size).toBe(catalogProviderDefinitions.length);
    for (const provider of catalogProviderDefinitions) {
      expect(provider.id).toBe(catalogProviderIds.find((id) => integrationRegistry[id] === provider));
      expect(provider.regions).toContain(provider.defaultRegion);
      expect(provider.category).toBe('catalog-source');
      expect(provider.freshnessWindowMs).toBeGreaterThan(0);
      expect(provider.operationsSources({}).every((source) => source.provider === provider.id)).toBe(true);
    }
  });

  it('declares portable queue pairs, alarm prefixes, and supported capabilities', () => {
    const queueReferences = new Set<string>();
    for (const provider of catalogProviderDefinitions) {
      expect(provider.queues.work).not.toBe(provider.queues.deadLetter);
      expect(provider.alarmPrefix).toMatch(/^InternNotifs/u);
      queueReferences.add(provider.queues.work);
      queueReferences.add(provider.queues.deadLetter);
      for (const action of provider.sourceActions) expect(supportedActions.has(action)).toBe(true);
      for (const workflow of provider.workflows) expect(supportedWorkflows.has(workflow)).toBe(true);
    }
    expect(queueReferences.size).toBe(catalogProviderDefinitions.length * 2);
  });

  it('retains the stable provider definitions and advertises implemented controls', () => {
    expect(integrationRegistry.greenhouse).toMatchObject({
      displayName: 'Greenhouse', regions: ['unknown'], defaultRegion: 'unknown', sourceActions: [...supportedActions], workflows: [],
    });
    expect(integrationRegistry.lever).toMatchObject({
      displayName: 'Lever', regions: ['global'], defaultRegion: 'global', workflows: ['candidate-review'],
    });
    expect(integrationRegistry.ashby).toMatchObject({
      displayName: 'Ashby', regions: ['global'], defaultRegion: 'global', workflows: [],
    });
    expect(integrationRegistry.github).toMatchObject({ sourceActions: [...supportedActions], workflows: [] });
  });

  it('matches source IDs through provider rules without ATS ambiguity', () => {
    expect(catalogProviderForSourceId('greenhouse-figma')).toBe('greenhouse');
    expect(catalogProviderForSourceId('shadow-lever-acme')).toBe('lever');
    expect(catalogProviderForSourceId('ashby-notion')).toBe('ashby');
    expect(catalogProviderForSourceId('markdown-fixture')).toBe('github');
    expect(catalogProviderDefinitions.filter((provider) => provider.matchesSourceId('greenhouse-figma')).map((provider) => provider.id))
      .toEqual(['greenhouse']);
  });
});
