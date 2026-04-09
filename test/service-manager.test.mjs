import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  __testInternals,
  getInstallDir,
  installBuiltinService
} = require("../dist-electron/main/service-manager.js");
const { getBuiltinService } = require("../dist-electron/main/service-registry.js");

test("parseEnvFileContent keeps key values and strips quotes", () => {
  const env = __testInternals.parseEnvFileContent(`
# comment
API_PORT=8088
WEB_SESSION_SECRET='top-secret'
`);

  assert.equal(env.get("API_PORT"), "8088");
  assert.equal(env.get("WEB_SESSION_SECRET"), "top-secret");
});

test("service install dir follows userData/services/<id>/<version>", () => {
  const userDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-service-dir-"));
  const app = {
    getPath(name) {
      assert.equal(name, "userData");
      return userDataRoot;
    }
  };

  const installDir = getInstallDir(app, getBuiltinService("pan-webclient"));
  assert.equal(
    installDir,
    path.join(userDataRoot, "services", "pan-webclient", "v0.1.0")
  );
});

test("parsePort understands bind addr for container hub and api port for pan", () => {
  const hubPort = __testInternals.parsePort(
    getBuiltinService("agent-container-hub"),
    new Map([["BIND_ADDR", "127.0.0.1:11960"]])
  );
  const panPort = __testInternals.parsePort(
    getBuiltinService("pan-webclient"),
    new Map([["API_PORT", "8123"]])
  );

  assert.equal(hubPort, 11960);
  assert.equal(panPort, 8123);
});

test("fixShellScriptPermissions marks shell scripts executable", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-shell-perm-"));
  const shellPath = path.join(root, "nested", "start.sh");
  const textPath = path.join(root, "nested", "notes.txt");

  fs.mkdirSync(path.dirname(shellPath), { recursive: true });
  fs.writeFileSync(shellPath, "#!/usr/bin/env bash\necho hi\n", "utf8");
  fs.writeFileSync(textPath, "plain text\n", "utf8");
  fs.chmodSync(shellPath, 0o644);
  fs.chmodSync(textPath, 0o644);

  __testInternals.fixShellScriptPermissions(root);

  assert.equal(fs.statSync(shellPath).mode & 0o777, 0o755);
  assert.equal(fs.statSync(textPath).mode & 0o777, 0o644);
});

test("listMissingRuntimeFiles detects damaged install directories", () => {
  const service = getBuiltinService("agent-container-hub");
  const installRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-damaged-install-"));

  fs.writeFileSync(path.join(installRoot, ".env.example"), "BIND_ADDR=127.0.0.1:11960\n", "utf8");

  const missingFiles = __testInternals.listMissingRuntimeFiles(service, installRoot);
  assert.ok(missingFiles.includes("start.sh"));
  assert.ok(missingFiles.includes("agent-container-hub"));
  assert.equal(__testInternals.isInstallHealthy(service, installRoot), false);
});

test("installBuiltinService repairs damaged install and preserves env", async () => {
  const service = getBuiltinService("agent-container-hub");
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-repair-install-"));
  const assetsRoot = path.join(tempRoot, "assets");
  const serviceAssetDir = path.join(assetsRoot, service.id);
  const userDataRoot = path.join(tempRoot, "user-data");
  const installDir = path.join(userDataRoot, "services", service.id, service.version);
  const tarFixtureRoot = path.join(tempRoot, "bundle-root");
  const tarBundleRoot = path.join(tarFixtureRoot, service.bundleTopLevelDir);
  const tarPath = path.join(serviceAssetDir, service.assetFileName);
  const envContent = "BIND_ADDR=127.0.0.1:12000\n";

  fs.mkdirSync(path.join(tarBundleRoot, "configs", "environments"), { recursive: true });
  fs.mkdirSync(path.join(tarBundleRoot, "data", "rootfs"), { recursive: true });
  fs.mkdirSync(path.join(tarBundleRoot, "data", "builds"), { recursive: true });
  fs.writeFileSync(path.join(tarBundleRoot, "agent-container-hub"), "binary", "utf8");
  fs.writeFileSync(path.join(tarBundleRoot, "start.sh"), "#!/usr/bin/env bash\necho start\n", "utf8");
  fs.writeFileSync(path.join(tarBundleRoot, "stop.sh"), "#!/usr/bin/env bash\necho stop\n", "utf8");
  fs.writeFileSync(path.join(tarBundleRoot, ".env.example"), "BIND_ADDR=127.0.0.1:11960\n", "utf8");
  fs.writeFileSync(
    path.join(tarBundleRoot, "configs", "environments", "example.yml"),
    "name: example\n",
    "utf8"
  );

  fs.mkdirSync(serviceAssetDir, { recursive: true });
  execFileSync("tar", ["-czf", tarPath, "-C", tarFixtureRoot, service.bundleTopLevelDir]);

  fs.mkdirSync(installDir, { recursive: true });
  fs.writeFileSync(path.join(installDir, ".env"), envContent, "utf8");
  fs.writeFileSync(path.join(installDir, ".env.example"), "BIND_ADDR=127.0.0.1:11960\n", "utf8");
  fs.writeFileSync(path.join(installDir, "README.txt"), "broken\n", "utf8");
  fs.mkdirSync(path.join(installDir, "configs"), { recursive: true });

  process.env.ZENMIND_DESKTOP_BUILTIN_ASSETS_ROOT = assetsRoot;

  const app = {
    isPackaged: false,
    getPath(name) {
      assert.equal(name, "userData");
      return userDataRoot;
    }
  };

  await installBuiltinService(app, service.id);

  assert.equal(fs.readFileSync(path.join(installDir, ".env"), "utf8"), envContent);
  assert.ok(fs.existsSync(path.join(installDir, "start.sh")));
  assert.ok(fs.existsSync(path.join(installDir, "stop.sh")));
  assert.ok(fs.existsSync(path.join(installDir, "agent-container-hub")));
  assert.equal(__testInternals.isInstallHealthy(service, installDir), true);

  delete process.env.ZENMIND_DESKTOP_BUILTIN_ASSETS_ROOT;
  fs.rmSync(tempRoot, { recursive: true, force: true });
});
