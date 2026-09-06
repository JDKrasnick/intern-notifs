import { describe, expect, it } from 'vitest';
import pagesAssetPath from '../scripts/pages-asset-path.cjs';

describe('Pages runtime asset paths', () => {
  it('relocates exported dependency assets without changing file identity', () => {
    const asset = { httpServerLocation: '/assets?export_path=/assets/node_modules/@expo/icons/node_modules/fonts',
      name: 'Ionicons', hash: 'unchanged', files: ['/project/node_modules/icons.ttf'] };
    expect(pagesAssetPath(asset)).toEqual({ ...asset,
      httpServerLocation: '/assets?export_path=/assets/vendor/@expo/icons/vendor/fonts' });
    expect(asset.httpServerLocation).toContain('/node_modules/');
  });
  it('preserves application asset paths and non-directory lookalikes', () => {
    const asset = { httpServerLocation: '/assets/images/node_modules_logo' };
    expect(pagesAssetPath(asset)).toEqual(asset);
  });
});
