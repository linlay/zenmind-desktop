import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const {
  buildWebappSettingsPath,
  readSettingsWebappId
} = await import("../dist-electron/shared/settings-routes.js");
const { readWebappPublishState } = await import("../dist-electron/main/modules/webs/webapps/publisher.js");
const { getDesktopWebappStateRoot } = await import("../dist-electron/main/infrastructure/filesystem/user-paths.js");

test("WebApp settings deep links encode and recover a selected application", () => {
  const route = buildWebappSettingsPath(" app/id with spaces ");
  assert.equal(route, "/settings/webapps?webappId=app%2Fid+with+spaces");
  assert.equal(readSettingsWebappId("?webappId=app%2Fid+with+spaces"), "app/id with spaces");
  assert.equal(buildWebappSettingsPath("  "), "/settings/webapps");
  assert.equal(readSettingsWebappId("?unrelated=1"), "");
});

test("missing and damaged WebApp publication files resolve to null", () => {
  const temporaryHome = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-webapp-publish-state-"));
  const app = {
    getPath(name) {
      if (name === "home") {
        return temporaryHome;
      }
      throw new Error(`Unexpected Electron path: ${name}`);
    }
  };
  const webappId = "test-webapp";
  try {
    assert.equal(readWebappPublishState(app, webappId), null);
    const stateRoot = getDesktopWebappStateRoot(app, webappId);
    fs.mkdirSync(stateRoot, { recursive: true });
    fs.writeFileSync(path.join(stateRoot, "publish.json"), "{damaged", "utf8");
    assert.equal(readWebappPublishState(app, webappId), null);
  } finally {
    fs.rmSync(temporaryHome, { recursive: true, force: true });
  }
});

// Load the small pure renderer projection; lifecycle coverage stays in the IPC tests.
test("publication labels follow runtime and Tunnel availability", () => {
  const require = createRequire(import.meta.url);
  const ts = require("typescript");
  const source = fs.readFileSync(path.join(projectRoot, "src/renderer/pages/settings/webappPublishPresentation.ts"), "utf8");
  const mod = { exports: {} };
  new Function("exports", ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS }
  }).outputText)(mod.exports);
  const published = { active: true };
  for (const [state, info, runtime, label] of [
    [undefined, null, null, "publishStatusChecking"],
    [null, null, null, "publishStatusNotPublished"],
    [published, null, undefined, "publishStatusChecking"],
    [published, null, { status: "stopped" }, "publishAppStopped"],
    [published, null, { status: "running" }, "publishStatusChecking"],
    [published, { tunnelConnected: false }, { status: "running" }, "publishTunnelOffline"],
    [published, { tunnelConnected: true }, { status: "running" }, "publishStatusTunnelConnected"]
  ]) assert.equal(mod.exports.getWebappPublishPresentation(state, info, runtime).label, `settings.webapps.${label}`);
});
