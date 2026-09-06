const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
// Only dependency-free public display contracts live outside the Expo project.
config.watchFolders = [...config.watchFolders, path.resolve(__dirname, '../shared')];
module.exports = config;
