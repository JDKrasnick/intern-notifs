const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

// Public display helpers are shared with the API and live outside the Expo root.
config.watchFolders = [...config.watchFolders, path.resolve(__dirname, "../shared")];

module.exports = config;
