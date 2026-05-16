import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { issueAgentAccessToken } = require("../dist-electron/main/agent-auth.js");
const {
  __testInternals: registryInternals,
  registerPlugin
} = require("../dist-electron/main/service-registry.js");

function createAppStub(root) {
  return {
    getPath(name) {
      if (name === "home") {
        return path.join(root, "home");
      }
      if (name === "appData") {
        return path.join(root, "appData");
      }
      if (name === "userData") {
        return path.join(root, "userData");
      }
      return root;
    }
  };
}

function decodeJson(part) {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

function registerAppServerFixture(root) {
  const service = registerPlugin({
    id: "zenmind-app-server",
    name: "认证服务",
    kind: "builtin",
    version: "v1.0.0",
    description: "fixture",
    frontend: { mode: "standalone" },
    scripts: {
      start: "start.sh",
      stop: "stop.sh"
    },
    runtime: {},
    web: {
      routePath: "/admin/",
      portEnvKey: "SERVER_PORT",
      defaultPort: 7076
    },
    desktop: {
      bundleTopLevelDir: "zenmind-app-server"
    }
  });
  const programDir = path.join(root, "appData", "ZenMind", "services", service.id, service.version);
  const configDir = path.join(root, "home", ".zenmind", ".desktop", "config", "services", service.id);
  fs.mkdirSync(path.join(programDir, "scripts"), { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, ".env"),
    [
      "SERVER_PORT=7076",
      "AUTH_DB_PATH=" + path.join(root, "home", ".zenmind", ".desktop", "data", "services", service.id, "auth.db"),
      "AUTH_ISSUER=http://issuer.test",
      "AUTH_APP_USERNAME=app"
    ].join("\n") + "\n",
    "utf8"
  );
  fs.writeFileSync(
    path.join(programDir, "scripts", "setup-public-key.sh"),
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "public_out=''",
      "while [ $# -gt 0 ]; do",
      "  case \"$1\" in",
      "    --public-out) public_out=\"$2\"; shift 2 ;;",
      "    *) shift ;;",
      "  esac",
      "done",
      "mkdir -p \"$(dirname \"$public_out\")\"",
      "printf 'APP_SERVER_PUBLIC_KEY\\n' > \"$public_out\""
    ].join("\n") + "\n",
    "utf8"
  );
  fs.writeFileSync(
    path.join(programDir, "scripts", "issue-bridge-access-token.sh"),
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "printf '%s\\n' 'eyJhbGciOiJSUzI1NiIsImtpZCI6ImZpeHR1cmUiLCJ0eXAiOiJKV1QifQ.eyJpc3MiOiJodHRwOi8vaXNzdWVyLnRlc3QiLCJzdWIiOiJhcHAiLCJzY29wZSI6ImFwcCIsImRldmljZV9pZCI6ImRldmljZS0xIn0.signature'"
    ].join("\n") + "\n",
    "utf8"
  );
  fs.chmodSync(path.join(programDir, "scripts", "setup-public-key.sh"), 0o755);
  fs.chmodSync(path.join(programDir, "scripts", "issue-bridge-access-token.sh"), 0o755);
}

test("issueAgentAccessToken uses zenmind-app-server to issue an app token", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-agent-auth-"));
  const app = createAppStub(tempRoot);
  registerAppServerFixture(tempRoot);

  try {
    const result = await issueAgentAccessToken(app, "missing");
    assert.equal(result.ok, true);
    assert.match(result.token, /^.+\..+\..+$/);
    const [, payloadPart] = result.token.split(".");
    const payload = decodeJson(payloadPart);
    assert.equal(payload.iss, "http://issuer.test");
    assert.equal(payload.sub, "app");
    assert.equal(payload.scope, "app");
    assert.equal(payload.device_id, "device-1");
    assert.equal(
      fs.readFileSync(
        path.join(tempRoot, "home", ".zenmind", ".desktop", "data", "services", "zenmind-app-server", "keys", "publicKey.pem"),
        "utf8"
      ),
      "APP_SERVER_PUBLIC_KEY\n"
    );
  } finally {
    registryInternals.clearServices();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("issueAgentAccessToken returns an app-server error when token issuing is unavailable", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-agent-auth-"));
  const app = createAppStub(tempRoot);

  try {
    const result = await issueAgentAccessToken(app, "unauthorized");
    assert.equal(result.ok, false);
    assert.equal(result.token, "");
    assert.match(result.message, /unknown service id: zenmind-app-server/u);
  } finally {
    registryInternals.clearServices();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
