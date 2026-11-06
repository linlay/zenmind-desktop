import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { build } from "esbuild";
import electron from "electron";
import { loadBrandConfig, resolveBrandId, runtimeBrandPayload } from "../scripts/lib/brand-config.mjs";

const project = path.resolve(import.meta.dirname, "..");
const unavailable = !fs.statSync(electron, { throwIfNoEntry: false })?.isFile()
  ? "Electron executable is unavailable"
  : process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY
    ? "A display server is required for the isolated Electron fixture"
    : false;

test("real settings component releases subscriptions, ignores late replies and saves authorization without echoing it", {
  skip: unavailable, timeout: 45_000,
}, async t => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "browser-settings-ui-"));
  let child, guard;
  t.after(() => {
    clearTimeout(guard);
    if (child && child.exitCode === null) child.kill("SIGTERM");
    fs.rmSync(output, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const env = { ...process.env, BROWSER_SETTINGS_UI_ROOT: output };
  delete env.ELECTRON_RUN_AS_NODE;
  await build({
    entryPoints: [path.join(project, "test/fixtures/browser-use-ui-renderer.tsx")],
    outfile: path.join(output, "renderer.js"), bundle: true, platform: "browser", format: "cjs",
    external: ["electron"], jsx: "automatic", loader: { ".svg": "dataurl", ".png": "dataurl" },
    define: { __DESKTOP_APP_BRAND__: JSON.stringify(runtimeBrandPayload(loadBrandConfig(project, resolveBrandId()))),
      "process.env.NODE_ENV": '"production"' }, logLevel: "silent",
  });
  await build({ entryPoints: [path.join(project, "src/shared/browser-use.ts")], outfile: path.join(output, "channels.cjs"),
    bundle: true, platform: "node", format: "cjs", logLevel: "silent" });
  fs.writeFileSync(path.join(output, "fixture.html"), '<!doctype html><html data-theme="light"><meta charset="utf-8"><link rel="stylesheet" href="renderer.css"><body><div id="root"></div><script src="renderer.js"></script></body></html>');
  child = spawn(electron, [path.join(project, "test/fixtures/browser-use-settings-ui-electron.cjs")], {
    env, stdio: ["ignore", "pipe", "pipe"],
  });
  let diagnostic = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", data => { diagnostic = (diagnostic + data).slice(-12_000); });
  }
  guard = setTimeout(() => child.kill("SIGTERM"), 35_000);
  const [code, signal] = await once(child, "exit");
  assert.equal(code, 0, `${signal || ""}\n${diagnostic}`);
  const result = JSON.parse(fs.readFileSync(path.join(output, "report.json"), "utf8"));
  assert.equal(result.ok, true);
  assert.deepEqual(result.cases, [
    "no-toolbar-button-and-request-opens-dialog", "clean-settings-and-three-step-guide-without-crypto", "repeated-mount-unmount", "workpanel-default-without-selector", "late-get-does-not-replace-new-draft",
    "save-clears-write-only-authorization", "late-save-does-not-replace-forget", "pasting-authorization-enables-remember", "final-unsubscribe",
  ]);
  assert.deepEqual(result.listenerCounts, [0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0]);
  assert.equal(result.saveCalls, 2);
  assert.equal(result.forgetCalls, 1);
  assert.deepEqual(result.errors, []);
  t.diagnostic(`${result.cases.length} rendered React settings scenarios passed; isolated Electron profile and mocked settings IPC only.`);
});
