const fs = require("node:fs");
const path = require("node:path");

const WEBAPP_TOOLING_RESOURCE_RELATIVE_PATH = "scripts/webapp-tooling.mjs";

function resolvePackagedWebappToolingPath(resourcesRoot, pathApi = path) {
  return pathApi.join(resourcesRoot, ...WEBAPP_TOOLING_RESOURCE_RELATIVE_PATH.split("/"));
}

function verifyPackagedWebappTooling(resourcesRoot, { errorPrefix = "[webapp-tooling]" } = {}) {
  const toolingPath = resolvePackagedWebappToolingPath(resourcesRoot);
  let stat;
  try {
    stat = fs.statSync(toolingPath);
  } catch {
    throw new Error(`${errorPrefix} packaged WebApp Tooling is missing: ${toolingPath}`);
  }
  if (!stat.isFile() || stat.size === 0) {
    throw new Error(`${errorPrefix} packaged WebApp Tooling is not a non-empty file: ${toolingPath}`);
  }
  return toolingPath;
}

module.exports = {
  WEBAPP_TOOLING_RESOURCE_RELATIVE_PATH,
  resolvePackagedWebappToolingPath,
  verifyPackagedWebappTooling
};
