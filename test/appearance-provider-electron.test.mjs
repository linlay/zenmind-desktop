import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { build } from "esbuild";
import electron from "electron";
import { loadBrandConfig, resolveBrandId, runtimeBrandPayload } from "../scripts/lib/brand-config.mjs";

test("appearance provider keeps auxiliary WebViews read-only and main-window consumers subscribed", {
  skip: process.env.RUN_APPEARANCE_PROVIDER_ELECTRON_TEST !== "1", timeout: 45000
}, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "appearance-provider-electron-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await build({
    entryPoints: [fileURLToPath(new URL("./fixtures/appearance-provider-renderer.tsx", import.meta.url))],
    outfile: path.join(root, "fixture.js"), bundle: true, platform: "browser", format: "iife", jsx: "automatic",
    loader: { ".svg": "dataurl" },
    define: { "process.env.NODE_ENV": '"development"', "import.meta.env.DEV": "false",
      __DESKTOP_APP_BRAND__: JSON.stringify({ ...runtimeBrandPayload(loadBrandConfig(process.cwd(), resolveBrandId())), storageNamespace: "appearance-provider-test",
        protocols: { open: { scheme: "appearance-provider-test" } }, installer: { shutdownArg: "--stop" } }) }
  });
  fs.writeFileSync(path.join(root, "index.html"), '<!doctype html><link rel="stylesheet" href="./fixture.css"><div id="root"></div><script src="./fixture.js"></script>');
  fs.writeFileSync(path.join(root, "host-preload.cjs"), `
    const { contextBridge, ipcRenderer } = require('electron');
    const settings = Object.fromEntries(['getThemePreference', 'setNativeThemeSource', 'getDesktopSkin', 'setDesktopSkin',
      'importDesktopBackground', 'resetDesktopBackground'].map(method => [method, value => ipcRenderer.invoke('fixture.appearance', method, value)]));
    contextBridge.exposeInMainWorld('electronAPI', { settings,
      services: { list: async () => [{ id: 'agent-webclient', status: 'running', name: 'Fixture',
        kind: 'builtin', frontendMode: 'service', healthMeta: { webUrl: 'http://127.0.0.1:19789/', port: 19789 } }] },
      onServicesChanged: () => () => {},
      desktopShell: { setWebviewModalOverlayVisible: () => {} },
      serviceWebview: { getPreloadUrl: () => ipcRenderer.invoke('fixture.preload'), onSelectionToolbarState: () => () => {} },
      copilot: { publishDevToolsTarget: async () => {} },
      diagnostics: { reportRendererError: () => {} }
    });
  `);
  const { outputFiles } = await build({
    stdin: { contents: `import { AGENT_WEBCLIENT_APPEARANCE_REQUEST_CHANNEL as request,
        AGENT_WEBCLIENT_APPEARANCE_SNAPSHOT_CHANNEL as response } from './src/shared/contracts/agent-webclient-bridge';
      const { contextBridge, ipcRenderer } = require('electron');
      const documentId = '12345678-1234-1234-1234-123456789abc';
      let snapshot = null;
      contextBridge.exposeInMainWorld('appearanceFixture', { read: () => snapshot });
      const read = () => ipcRenderer.sendToHost(request, { version: 1, documentId, origin: location.origin });
      ipcRenderer.on(request, read);
      ipcRenderer.on(response, (_event, envelope) => {
        if (envelope.documentId === documentId) snapshot = envelope.snapshot;
      });
      window.addEventListener('DOMContentLoaded', read);`, resolveDir: process.cwd() },
    bundle: true, write: false, platform: "node", format: "cjs", external: ["electron"]
  });
  fs.writeFileSync(path.join(root, "guest-preload.cjs"), outputFiles[0].text);
  const env = { ...process.env, APPEARANCE_PROVIDER_TEST_ROOT: root };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [fileURLToPath(new URL("./fixtures/appearance-provider-electron.cjs", import.meta.url))],
    { env, stdio: ["ignore", "pipe", "pipe"] });
  const timeout = setTimeout(() => child.kill("SIGTERM"), 35000);
  t.after(() => { clearTimeout(timeout); if (child.exitCode === null) child.kill("SIGTERM"); });
  let output = "";
  child.stdout.on("data", (data) => { output += data; });
  child.stderr.on("data", (data) => { output += data; });
  const [code, signal] = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (exitCode, exitSignal) => resolve([exitCode, exitSignal]));
  });
  assert.equal(code, 0, `${signal || ""}\n${output}`);
  const result = JSON.parse(fs.readFileSync(path.join(root, "passed.json"), "utf8"));
  assert.equal(result.ok, true);
  assert.deepEqual(result.cases, ["auxiliary-dark", "auxiliary-light", "provider-subscription", "writable-hook-guard", "auxiliary-error-close"]);
});
