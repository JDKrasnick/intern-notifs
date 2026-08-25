export interface LatestRequestGuard {
  begin(key: string): number;
  invalidate(): void;
  isCurrent(generation: number, key: string): boolean;
}

/** Keeps async UI completions scoped to the latest selected resource. */
export function createLatestRequestGuard(): LatestRequestGuard {
  let generation = 0;
  let activeKey: string | undefined;
  return {
    begin(key) { activeKey = key; return ++generation; },
    invalidate() { activeKey = undefined; generation += 1; },
    isCurrent(candidate, key) { return candidate === generation && key === activeKey; },
  };
}
