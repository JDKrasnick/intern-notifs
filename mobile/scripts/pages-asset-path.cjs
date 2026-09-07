// Pages excludes any node_modules directory, including exported runtime assets.
// Run through Metro so emitted files, bundle references, and hashes stay aligned.
module.exports = function pagesAssetPath(asset) {
  return {
    ...asset,
    httpServerLocation: asset.httpServerLocation.replace(/\/node_modules(?=\/|$)/gu, "/vendor"),
  };
};
