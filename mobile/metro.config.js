const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
// Only dependency-free public display contracts live outside the Expo project.
config.watchFolders = [...config.watchFolders, path.resolve(__dirname, '../shared')];
if (process.env.INTERNNOTIFS_PAGES_EXPORT === '1') {
  config.transformer.assetPlugins = [...(config.transformer.assetPlugins ?? []),
    path.resolve(__dirname, 'scripts/pages-asset-path.cjs')];
}
module.exports = config;
