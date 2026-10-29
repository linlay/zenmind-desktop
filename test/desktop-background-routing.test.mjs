import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { build } from "esbuild";
import electron from "electron";

const repo = process.cwd();

test("the shell reserves eligible wallpaper before a lazy guest mounts", () => {
  const source = fs.readFileSync(path.join(repo, "src/renderer/app-shell/AppShell.tsx"), "utf8");
  assert.match(source, /isWebclientHostBackgroundSurface/u);
  assert.match(source, /["']has-webclient-background-surface["']/u);
});

test("the production guest reserves its eligible wallpaper surface before bridge negotiation", () => {
  const source = fs.readFileSync(path.join(repo, "src/renderer/service-webview/ServiceWebviewSurface.tsx"), "utf8");
  assert.match(source, /hostBackgroundSurface\s*&&\s*active\s*!==\s*false\s*\?\s*["']agent-webclient-background-surface["']/u);
  // The negotiated class remains independent: transport support still belongs
  // to the appearance bridge, while CSS eligibility is known before it replies.
  assert.match(source, /hostSkinBackground\s*\?\s*["']agent-webclient-host-background["']/u);
});

test("Chromium preserves wallpaper and reading surfaces through lazy routes and guest readiness", {
  skip: process.env.RUN_DESKTOP_BACKGROUND_ELECTRON_TEST !== "1",
  timeout: 60000
}, async t => {
  const artifacts = process.env.DESKTOP_BACKGROUND_TEST_ARTIFACTS;
  if (artifacts) fs.mkdirSync(artifacts, { recursive: true });
  const root = fs.mkdtempSync(path.join(artifacts || os.tmpdir(), "desktop-background-routing-"));
  if (!artifacts) t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await build({
    entryPoints: [fileURLToPath(new URL("./fixtures/desktop-background-renderer.tsx", import.meta.url))],
    outfile: path.join(root, "fixture.js"), bundle: true, platform: "browser", format: "iife", jsx: "automatic",
    loader: { ".svg": "dataurl", ".png": "dataurl" },
    define: {
      "process.env.NODE_ENV": '"production"'
    }
  });
  fs.writeFileSync(path.join(root, "index.html"), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><style>html,body,#root{height:100%;margin:0}</style><div id="root"></div><script src="fixture.js"></script>');
  const env = { ...process.env, DESKTOP_BACKGROUND_TEST_ROOT: root };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [fileURLToPath(new URL("./fixtures/desktop-background-electron.cjs", import.meta.url))], {
    env, stdio: ["ignore", "pipe", "pipe"]
  });
  const timeout = setTimeout(() => child.kill("SIGTERM"), 45000);
  t.after(() => { clearTimeout(timeout); if (child.exitCode === null) child.kill("SIGTERM"); });
  let output = "";
  child.stdout.on("data", data => { output += data; });
  child.stderr.on("data", data => { output += data; });
  const [code, signal] = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (exitCode, exitSignal) => resolve([exitCode, exitSignal]));
  });
  assert.equal(code, 0, `${signal || ""}\n${output}\nFixture: ${root}`);
  const result = JSON.parse(fs.readFileSync(path.join(root, "passed.json"), "utf8"));
  assert.equal(result.ok, true);
  assert.equal(result.surfaces.length, 4);
  assert.equal(result.lazyTransitions.length, 2);
  assert.deepEqual(result.rendererErrors, []);
  if (artifacts) t.diagnostic(`Evidence: ${path.join(root, "passed.json")}`);
});
