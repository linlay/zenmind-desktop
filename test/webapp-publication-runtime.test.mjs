import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Tunnel reconnect synchronizes already-running published WebApps", () => {
  const source = fs.readFileSync(
    path.join(projectRoot, "src/main/webs/webapps/publication-runtime.ts"),
    "utf8"
  );

  assert.match(source, /runtime\?\.status === "running" && runtime\.webUrl/u);
  assert.match(source, /await syncPublishedWebappRoute\(app, item, runtime\);[\s\S]*?continue;/u);
  assert.match(source, /await webappRuntime\.start\(app, item\.id\);/u);
});
