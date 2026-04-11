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
const { loadBuiltinServices } = require("../dist-electron/main/builtin-loader.js");
const {
  __testInternals: registryInternals,
  getBuiltinService
} = require("../dist-electron/main/service-registry.js");

function createApp(userDataRoot) {
  return {
    isPackaged: false,
    getPath(name) {
      assert.equal(name, "userData");
      return userDataRoot;
    }
  };
}

function loadBuiltinsForTest(userDataRoot, assetsRoot) {
  const previousAssetsRoot = process.env.ZENMIND_DESKTOP_BUILTIN_ASSETS_ROOT;
  if (assetsRoot) {
    process.env.ZENMIND_DESKTOP_BUILTIN_ASSETS_ROOT = assetsRoot;
  } else {
    delete process.env.ZENMIND_DESKTOP_BUILTIN_ASSETS_ROOT;
  }

  registryInternals.clearServices();
  const app = createApp(userDataRoot);
  loadBuiltinServices(app);

  return {
    app,
    restore() {
      registryInternals.clearServices();
      if (previousAssetsRoot) {
        process.env.ZENMIND_DESKTOP_BUILTIN_ASSETS_ROOT = previousAssetsRoot;
      } else {
        delete process.env.ZENMIND_DESKTOP_BUILTIN_ASSETS_ROOT;
      }
    }
  };
}

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
  const { app, restore } = loadBuiltinsForTest(userDataRoot);
  const installDir = getInstallDir(app, getBuiltinService("agent-platform"));
  assert.equal(
    installDir,
    path.join(userDataRoot, "services", "agent-platform", "v0.1.0")
  );
  restore();
});

test("parsePort understands bind addr for container hub and server port for agent platform", () => {
  const userDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-service-port-"));
  const { restore } = loadBuiltinsForTest(userDataRoot);
  const hubPort = __testInternals.parsePort(
    getBuiltinService("agent-container-hub"),
    new Map([["BIND_ADDR", "127.0.0.1:11960"]])
  );
  const platformPort = __testInternals.parsePort(
    getBuiltinService("agent-platform"),
    new Map([["SERVER_PORT", "8123"]])
  );

  assert.equal(hubPort, 11960);
  assert.equal(platformPort, 8123);
  restore();
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
  const userDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-damaged-registry-"));
  const { restore } = loadBuiltinsForTest(userDataRoot);
  const service = getBuiltinService("agent-container-hub");
  const installRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-damaged-install-"));

  fs.writeFileSync(path.join(installRoot, ".env.example"), "BIND_ADDR=127.0.0.1:11960\n", "utf8");

  const missingFiles = __testInternals.listMissingRuntimeFiles(service, installRoot);
  assert.ok(missingFiles.includes("start.sh"));
  assert.ok(missingFiles.includes("backend/agent-container-hub"));
  assert.ok(missingFiles.includes("manifest.json"));
  assert.equal(__testInternals.isInstallHealthy(service, installRoot), false);
  restore();
});

test("installBuiltinService repairs damaged install and preserves env", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-repair-install-"));
  const assetsRoot = path.join(tempRoot, "assets");
  const userDataRoot = path.join(tempRoot, "user-data");
  const installDir = path.join(userDataRoot, "services", "agent-container-hub", "v0.1.0");
  const tarFixtureRoot = path.join(tempRoot, "bundle-root");
  const tarBundleRoot = path.join(tarFixtureRoot, "agent-container-hub");
  const serviceAssetDir = path.join(assetsRoot, "agent-container-hub");
  const tarPath = path.join(serviceAssetDir, "agent-container-hub-v0.1.0-darwin-arm64.tar.gz");
  const envContent = "BIND_ADDR=127.0.0.1:12000\n";

  fs.mkdirSync(path.join(tarBundleRoot, "backend"), { recursive: true });
  fs.mkdirSync(path.join(tarBundleRoot, "configs", "environments"), { recursive: true });
  fs.mkdirSync(path.join(tarBundleRoot, "data", "rootfs"), { recursive: true });
  fs.mkdirSync(path.join(tarBundleRoot, "data", "builds"), { recursive: true });
  fs.mkdirSync(path.join(tarBundleRoot, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(tarBundleRoot, "backend", "agent-container-hub"), "binary", "utf8");
  fs.writeFileSync(path.join(tarBundleRoot, "deploy.sh"), "#!/usr/bin/env bash\necho deploy\n", "utf8");
  fs.writeFileSync(path.join(tarBundleRoot, "start.sh"), "#!/usr/bin/env bash\necho start\n", "utf8");
  fs.writeFileSync(path.join(tarBundleRoot, "stop.sh"), "#!/usr/bin/env bash\necho stop\n", "utf8");
  fs.writeFileSync(path.join(tarBundleRoot, "scripts", "program-common.sh"), "#!/usr/bin/env bash\n", "utf8");
  fs.writeFileSync(path.join(tarBundleRoot, ".env.example"), "BIND_ADDR=127.0.0.1:11960\n", "utf8");
  fs.writeFileSync(
    path.join(tarBundleRoot, "manifest.json"),
    `${JSON.stringify(
      {
        id: "agent-container-hub",
        name: "Container Hub",
        kind: "builtin",
        version: "v0.1.0",
        description: "fixture",
        frontend: {
          mode: "embedded",
          entry: "/",
          assetsPrefix: "/ui/",
          directAccess: true,
          hostManaged: false
        },
        api: {
          enabled: true
        },
        backend: {
          entry: "backend/agent-container-hub"
        },
        scripts: {
          start: ["start.sh", "--daemon"],
          stop: "stop.sh",
          deploy: "deploy.sh"
        },
        configFiles: [
          {
            key: "env",
            label: ".env",
            relativePath: ".env",
            templateRelativePath: ".env.example",
            required: true
          }
        ],
        runtime: {
          pidRelativePath: "run/agent-container-hub.pid",
          logRelativePath: "run/agent-container-hub.log",
          requiredPaths: [
            "backend/agent-container-hub",
            "start.sh",
            "stop.sh",
            "deploy.sh",
            "scripts/program-common.sh",
            ".env.example",
            "manifest.json",
            "configs/environments"
          ]
        },
        web: {
          routePath: "/",
          portEnvKey: "BIND_ADDR",
          defaultPort: 11960
        },
        desktop: {
          assetFileName: "agent-container-hub-v0.1.0-darwin-arm64.tar.gz",
          bundleTopLevelDir: "agent-container-hub"
        }
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  fs.writeFileSync(
    path.join(tarBundleRoot, "configs", "environments", "example.yml"),
    "name: example\n",
    "utf8"
  );

  fs.mkdirSync(serviceAssetDir, { recursive: true });
  execFileSync("tar", ["-czf", tarPath, "-C", tarFixtureRoot, "agent-container-hub"]);

  fs.mkdirSync(installDir, { recursive: true });
  fs.writeFileSync(path.join(installDir, ".env"), envContent, "utf8");
  fs.writeFileSync(path.join(installDir, ".env.example"), "BIND_ADDR=127.0.0.1:11960\n", "utf8");
  fs.writeFileSync(path.join(installDir, "README.txt"), "broken\n", "utf8");
  fs.mkdirSync(path.join(installDir, "configs"), { recursive: true });

  const { app, restore } = loadBuiltinsForTest(userDataRoot, assetsRoot);
  const service = getBuiltinService("agent-container-hub");

  await installBuiltinService(app, service.id);

  assert.equal(fs.readFileSync(path.join(installDir, ".env"), "utf8"), envContent);
  assert.ok(fs.existsSync(path.join(installDir, "start.sh")));
  assert.ok(fs.existsSync(path.join(installDir, "stop.sh")));
  assert.ok(fs.existsSync(path.join(installDir, "backend", "agent-container-hub")));
  assert.ok(fs.existsSync(path.join(installDir, "manifest.json")));
  assert.equal(__testInternals.isInstallHealthy(service, installDir), true);

  restore();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("ensurePreStartRequirements injects container hub url and auth public key for agent platform", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-agent-platform-prestart-"));
  const userDataRoot = path.join(tempRoot, "user-data");
  const { app, restore } = loadBuiltinsForTest(userDataRoot);
  const hubService = getBuiltinService("agent-container-hub");
  const platformService = getBuiltinService("agent-platform");
  const hubInstallDir = path.join(userDataRoot, "services", hubService.id, hubService.version);
  const platformInstallDir = path.join(userDataRoot, "services", platformService.id, platformService.version);

  fs.mkdirSync(hubInstallDir, { recursive: true });
  fs.mkdirSync(path.join(platformInstallDir, "configs"), { recursive: true });
  fs.writeFileSync(path.join(hubInstallDir, ".env"), "BIND_ADDR=0.0.0.0:12960\n", "utf8");
  fs.writeFileSync(
    path.join(platformInstallDir, ".env"),
    "HOST_PORT=11949\nAGENT_CONTAINER_HUB_BASE_URL=http://host.docker.internal:11960\nAGENT_AUTH_ENABLED=false\n",
    "utf8"
  );

  await __testInternals.ensurePreStartRequirements(app, platformService);

  const envContent = fs.readFileSync(path.join(platformInstallDir, ".env"), "utf8");
  assert.match(envContent, /AGENT_CONTAINER_HUB_BASE_URL=http:\/\/127\.0\.0\.1:12960/);
  assert.match(envContent, /SERVER_PORT=11949/);
  assert.match(envContent, /AGENT_AUTH_ENABLED=true/);
  assert.match(envContent, /AGENT_AUTH_LOCAL_PUBLIC_KEY_FILE=configs\/local-public-key\.pem/);

  const publicKeyPath = path.join(platformInstallDir, "configs", "local-public-key.pem");
  assert.ok(fs.existsSync(publicKeyPath));
  assert.match(fs.readFileSync(publicKeyPath, "utf8"), /BEGIN PUBLIC KEY/);

  restore();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});
