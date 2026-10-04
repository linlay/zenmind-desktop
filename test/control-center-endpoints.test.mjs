import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const projectRoot = process.cwd();
const sourcePath = path.join(
  projectRoot,
  "src",
  "renderer",
  "pages",
  "control-center",
  "serviceEndpoints.ts",
);
const source = fs.readFileSync(sourcePath, "utf8");
const { outputText } = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: sourcePath,
});
const mod = { exports: {} };
new Function("exports", "require", "module", "__filename", "__dirname", outputText)(
  mod.exports,
  require,
  mod,
  sourcePath,
  path.dirname(sourcePath),
);

const { resolveControlCenterEndpoint, shouldOpenControlCenterEndpointInternally } = mod.exports;
const service = (id, webUrl, frontendMode = "none") => ({ id, healthMeta: { webUrl }, frontendMode });

test("service entrypoints preserve current URL normalization and fallback behavior", () => {
  for (const [id, endpoint] of [["identity-center", "/admin/"], ["agent-platform", "/monitor"]]) {
    assert.equal(resolveControlCenterEndpoint(service(id, "  ")), "");
    assert.equal(resolveControlCenterEndpoint(service(id, " https://localhost:8080/old?q=1#top ")), `https://localhost:8080${endpoint}`);
    assert.equal(resolveControlCenterEndpoint(service(id, `https://localhost:8080${endpoint}?q=1#top`)), `https://localhost:8080${endpoint}?q=1#top`);
    assert.equal(resolveControlCenterEndpoint(service(id, "not a url///")), `not a url${endpoint}`);
  }
  assert.equal(resolveControlCenterEndpoint(service("plugin", "https://example.test/app?q=1#top")), "https://example.test/app?q=1#top");
});

test("frontend availability controls internal opening with the Platform monitor exception", () => {
  assert.equal(shouldOpenControlCenterEndpointInternally(service("agent-platform", "", "none")), true);
  assert.equal(shouldOpenControlCenterEndpointInternally(service("plugin", "", "none")), false);
  assert.equal(shouldOpenControlCenterEndpointInternally(service("plugin", "", "embedded")), true);
});
