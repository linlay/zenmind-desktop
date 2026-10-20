import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { __testInternals: { stableWebappName } } = require("../dist-electron/main/modules/webs/webapps/publisher.js");

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("published WebApp names preserve canonical IDs and distinguish legacy identities", () => {
  const canonicalId = "webapp-0123456789abcdef";
  assert.equal(stableWebappName(canonicalId), canonicalId);
  const ids = ["legacy-notes", "Legacy Notes", "legacy_notes", "便签工具", "Legacy Notes # %2F"];
  const names = ids.map(stableWebappName);
  assert.equal(new Set(names).size, ids.length);
  for (const [index, name] of names.entries()) {
    assert.equal(stableWebappName(ids[index]), name);
    assert.ok(name.length <= 63);
    assert.match(name, /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u);
  }
});

test("Tunnel reconnect synchronizes already-running published WebApps", () => {
  const source = fs.readFileSync(
    path.join(projectRoot, "src/main/modules/webs/webapps/publication-runtime.ts"),
    "utf8"
  );

  assert.match(source, /runtime\?\.status === "running" && runtime\.webUrl/u);
  assert.match(source, /await syncPublishedWebappRoute\(app, item, runtime, ports\);[\s\S]*?continue;/u);
  assert.match(source, /await runtimeFacade\.start\(app, item\.id\);/u);
});
