import assert from "node:assert/strict";
import test from "node:test";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ErrorReportingManager, mapDiagnosticSource, sanitizeErrorText } from "../dist-electron/main/error-reporting/manager.js";
import {
  getErrorReportingSettingsPath,
  normalizeErrorReportingEndpoint,
  readErrorReportingSettings,
  writeErrorReportingSettings
} from "../dist-electron/main/error-reporting/settings.js";
import { getDesktopStateRoot } from "../dist-electron/main/user-paths.js";
import { APP_ID, BRAND_ID } from "../dist-electron/shared/brand.js";

function createDarwinDevelopmentContext(projectRoot) {
  return {
    platform: "darwin",
    env: {
      __CFBundleIdentifier: `${APP_ID}.dev`,
      VITE_DEV_SERVER_URL: "http://127.0.0.1:5173",
      DESKTOP_DEV_RESOURCES_ROOT: path.join(projectRoot, "build", "brands", BRAND_ID, "resources")
    },
    argv: ["ZenMind", projectRoot],
    execPath: path.join(projectRoot, "build", "brands", BRAND_ID, "dev", "ZenMind.app", "Contents", "MacOS", "ZenMind")
  };
}

test("error reporting strips credentials and local user paths", () => {
  const sanitized = sanitizeErrorText("token=secret /Users/alice/project/index.ts access_token=abc");
  assert.doesNotMatch(sanitized, /secret|alice|abc/u);
  assert.match(sanitized, /\[REDACTED\]|<local-path>/u);
});

test("error reporting maps all reused renderer sources", () => {
  assert.equal(mapDiagnosticSource("unhandledrejection"), "unhandled_rejection");
  assert.equal(mapDiagnosticSource("react-error-boundary"), "react_error_boundary");
  assert.equal(mapDiagnosticSource("service-webview"), "service_webview");
  assert.equal(mapDiagnosticSource("preload"), "preload");
  assert.equal(mapDiagnosticSource("main"), "main");
});

test("production reporting only accepts HTTPS while development permits loopback HTTP", () => {
  assert.equal(normalizeErrorReportingEndpoint("https://ops.example.com/", true), "https://ops.example.com");
  assert.equal(normalizeErrorReportingEndpoint("http://127.0.0.1:8080", false), "http://127.0.0.1:8080");
  assert.throws(() => normalizeErrorReportingEndpoint("http://ops.example.com", true), /HTTPS/u);
});

test("renamed macOS development app accepts loopback error reporting", (t) => {
  const homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-error-reporting-settings-"));
  t.after(() => fs.rmSync(homeRoot, { recursive: true, force: true }));
  const app = {
    isPackaged: true,
    getPath: () => homeRoot
  };
  const target = getErrorReportingSettingsPath(app, "darwin");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify({
    schemaVersion: 1,
    enabled: true,
    endpoint: "http://127.0.0.1:8080"
  }));

  const settings = readErrorReportingSettings(
    app,
    "darwin",
    createDarwinDevelopmentContext("/Users/test/zenmind-desktop")
  );
  assert.equal(settings.endpoint, "http://127.0.0.1:8080");
});

test("queue uploads anonymously or with canonical JWT and clears immediately when disabled", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-error-reporting-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = {
    isPackaged: false,
    getName: () => "ZenMind",
    getVersion: () => "1.2.3",
    getPath: (name) => name === "crashDumps" ? path.join(root, "crashes") : root
  };
  const uploadStates = [];
  const crashReporter = {
    start: () => undefined,
    setUploadToServer: (enabled) => uploadStates.push(enabled)
  };
  writeErrorReportingSettings(app, { enabled: true, endpoint: "http://127.0.0.1:8080" });
  const headers = [];
  const authenticated = new ErrorReportingManager(app, crashReporter, {
    getToken: () => "canonical.jwt",
    fetchImpl: async (_url, init) => { headers.push(init.headers); return new Response("{}", { status: 202 }); }
  });
  authenticated.start();
  authenticated.report("renderer", { source: "window-error", message: "boom token=secret" });
  await authenticated.flush();
  assert.equal(headers[0].authorization, "Bearer canonical.jwt");

  const anonymous = new ErrorReportingManager(app, crashReporter, {
    getToken: () => "",
    fetchImpl: async () => { throw new Error("offline"); }
  });
  anonymous.report("main", { source: "main", message: "offline" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  anonymous.setEnabled(false);
  const queuePath = path.join(getDesktopStateRoot(app), "error-reporting", "queue.json");
  assert.deepEqual(JSON.parse(fs.readFileSync(queuePath, "utf8")), []);
  assert.equal(uploadStates.at(-1), false);
});
