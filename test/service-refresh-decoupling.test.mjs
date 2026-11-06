import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const {
  computeAssetSignature,
  isInstallHealthy,
  listMissingBundleDirectoryEntries,
  listMissingRuntimeFiles
} = require("../dist-electron/main/modules/services/manager/bundle-assets.js");
const envNormalization = require("../dist-electron/main/modules/services/manager/env-normalization.js");
const { isAssetNewerThanInstall } = require("../dist-electron/main/modules/services/manager/execution-layout.js");
const { writeInitializationState } = require("../dist-electron/main/modules/services/manager/state-files.js");

function createTempDir(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeText(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

test("asset refresh follows initialization and bundle signatures, not service-owned config", (t) => {
  const root = createTempDir(t, "zenmind-asset-refresh-");
  const assetPath = path.join(root, "bundle.zip");
  const installDir = path.join(root, "installed");
  writeText(assetPath, "bundle-v1");
  assert.equal(isAssetNewerThanInstall(assetPath, installDir), true);
  writeInitializationState(installDir, {
    version: "1.0.0", status: "succeeded", updatedAt: new Date().toISOString(),
    assetSignature: computeAssetSignature(assetPath)
  });
  assert.equal(isAssetNewerThanInstall(assetPath, installDir), false);
  writeText(path.join(installDir, ".env"), "SERVICE_PRIVATE_SETTING=custom\n");
  writeText(path.join(installDir, "configs", "runtime.yml"), "privateKey: custom\n");
  assert.equal(isAssetNewerThanInstall(assetPath, installDir), false);
  writeText(assetPath, "bundle-v2-updated");
  assert.equal(isAssetNewerThanInstall(assetPath, installDir), true);
});

test("runtime.requiredPaths still drives generic install health", (t) => {
  const installDir = createTempDir(t, "zenmind-runtime-health-");
  const service = {
    runtime: {
      requiredPaths: ["backend/agent-platform", "start.sh"]
    }
  };
  writeText(path.join(installDir, "start.sh"), "#!/usr/bin/env bash\n");

  assert.deepEqual(listMissingRuntimeFiles(service, installDir), ["backend/agent-platform"]);
  assert.equal(isInstallHealthy(service, installDir), false);
});

test("agent-platform runtime directory is required when manifest declares it", (t) => {
  const installDir = createTempDir(t, "zenmind-platform-runtime-dir-health-");
  const service = {
    id: "agent-platform",
    runtime: {
      requiredPaths: ["backend/agent-platform", "start.sh", "runtime"]
    }
  };
  writeText(path.join(installDir, "backend", "agent-platform"), "binary\n");
  writeText(path.join(installDir, "start.sh"), "#!/usr/bin/env bash\n");

  assert.equal(fs.existsSync(path.join(installDir, "runtime")), false);
  assert.deepEqual(listMissingRuntimeFiles(service, installDir), ["runtime"]);
  assert.equal(isInstallHealthy(service, installDir), false);
});

test("agent-platform bundled directory requires manifest runtime dir", (t) => {
  const bundleDir = createTempDir(t, "zenmind-platform-bundle-dir-health-");
  const service = {
    id: "agent-platform",
    desktop: {
      bundleTopLevelDir: "agent-platform"
    },
    runtime: {
      requiredPaths: ["backend/agent-platform", "configs", "runtime"]
    }
  };
  writeText(path.join(bundleDir, "backend", "agent-platform"), "binary\n");
  fs.mkdirSync(path.join(bundleDir, "configs"), { recursive: true });

  assert.equal(fs.existsSync(path.join(bundleDir, "runtime")), false);
  assert.deepEqual(listMissingBundleDirectoryEntries(service, bundleDir), ["runtime"]);
  fs.rmSync(path.join(bundleDir, "backend"), { recursive: true, force: true });
  assert.deepEqual(listMissingBundleDirectoryEntries(service, bundleDir), ["backend/agent-platform", "runtime"]);
});

test("agent-platform config and env migration helpers are no longer exported by Desktop", () => {
  assert.equal("normalizeAgentPlatformEnvContentForRuntime" in envNormalization, false);
  assert.equal("normalizeAgentPlatformDeprecatedConfigFiles" in envNormalization, false);
  assert.equal("normalizeAgentPlatformBashConfigContent" in envNormalization, false);
  assert.equal("normalizeAgentPlatformFileToolsConfigContent" in envNormalization, false);
  assert.equal("normalizeAgentPlatformDurationConfigContent" in envNormalization, false);
});

test('service notifications invalidate an in-flight renderer list and fetch the latest state', {
  skip: process.env.RUN_APPEARANCE_PROVIDER_ELECTRON_TEST !== '1', timeout: 30000
}, async t => {
  const { build } = await import('esbuild');
  const { spawn } = await import('node:child_process');
  const electron = require('electron');
  const root = createTempDir(t, 'service-refresh-electron-');
  await build({ stdin: { contents: `
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import {ServicesProvider,useServices} from './src/renderer/services/ServicesContext';
    window.pending=[]; window.snapshots=[];
    window.electronAPI={services:{list:()=>new Promise(resolve=>pending.push(resolve))},
      onServicesChanged: callback=>{window.changed=callback;return()=>{}}};
    function Probe(){const value=useServices(); snapshots.push(value.services.map(s=>s.id).join(',')); return <output>{value.services.map(s=>s.id).join(',')}</output>}
    createRoot(document.getElementById('root')).render(<ServicesProvider><Probe/></ServicesProvider>);
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', outfile: path.join(root, 'fixture.js') });
  writeText(path.join(root, 'index.html'), '<div id="root"></div><script src="fixture.js"></script>');
  writeText(path.join(root, 'main.cjs'), `
    const {app,BrowserWindow}=require('electron'), assert=require('node:assert/strict');
    app.setPath('userData',${JSON.stringify(path.join(root, 'profile'))}); app.disableHardwareAcceleration();
    if(process.platform==='darwin')app.setActivationPolicy('prohibited');
    (async()=>{await app.whenReady();const w=new BrowserWindow({show:false,webPreferences:{backgroundThrottling:false}});
      await w.loadFile(${JSON.stringify(path.join(root, 'index.html'))});
      const js=s=>w.webContents.executeJavaScript(s);
      async function until(s){for(let i=0;i<150;i++){if(await js(s))return;await new Promise(r=>setTimeout(r,10));}throw Error('Timed out: '+s)}
      await until('window.pending?.length === 1 && !!window.changed');
      await js('changed(); pending.shift()([{id:"stale-enabled"}]);');
      await until('pending.length === 1');
      assert.equal(await js('snapshots.includes("stale-enabled")'),false);
      await js('pending.shift()([{id:"latest-disabled"}]);');
      await until('document.querySelector("output").textContent === "latest-disabled"');
      w.destroy();app.exit(0);
    })().catch(e=>{console.error(e);app.exit(1)});
  `);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [path.join(root, 'main.cjs')], { env, stdio: ['ignore','pipe','pipe'] });
  let output = ''; child.stdout.on('data', chunk => output += chunk); child.stderr.on('data', chunk => output += chunk);
  const timeout = setTimeout(() => child.kill(), 20000);
  t.after(() => { clearTimeout(timeout); if (child.exitCode === null) child.kill(); });
  const code = await new Promise((resolve, reject) => { child.on('exit', resolve); child.on('error', reject); });
  assert.equal(code, 0, output);
});
