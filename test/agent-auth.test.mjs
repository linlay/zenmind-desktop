import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { issueAgentAccessToken } = require("../dist-electron/main/agent-auth.js");
const { __testInternals: appServerAuthInternals } = require("../dist-electron/main/app-server-auth.js");
const {
  __testInternals: registryInternals,
  registerPlugin
} = require("../dist-electron/main/service-registry.js");
const {
  getServiceDataRoot,
  getServicesRoot,
  getServiceConfigRoot
} = require("../dist-electron/main/user-paths.js");

const TEST_APP_SERVER_BCRYPT = "$2a$10$VAC1MOfQV2f6L3LqgU5PweT25AdVaRK3yvMLwXjA0uRUhtnbbQ1ue";

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

function registerAppServerFixture(root, options = {}) {
  const app = createAppStub(root);
  const isWindows = process.platform === "win32";
  const ext = isWindows ? "ps1" : "sh";
  const service = registerPlugin({
    id: "zenmind-app-server",
    name: "认证服务",
    kind: "builtin",
    version: "v1.0.0",
    description: "fixture",
    frontend: { mode: "standalone" },
    scripts: {
      start: `start.${ext}`,
      stop: `stop.${ext}`
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
  const programDir = path.join(getServicesRoot(app), service.id, service.version);
  const configDir = getServiceConfigRoot(app, service.id, service.kind);
  fs.mkdirSync(path.join(programDir, "scripts"), { recursive: true });
  if (options.includeBackendBinary) {
    const binaryName = isWindows ? "zenmind-app-server.exe" : "zenmind-app-server";
    fs.mkdirSync(path.join(programDir, "backend"), { recursive: true });
    fs.writeFileSync(path.join(programDir, "backend", binaryName), "backend fixture\n", "utf8");
  }
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, ".env"),
    [
      "SERVER_PORT=7076",
      "AUTH_DB_PATH=" + path.join(getServiceDataRoot(app, service.id, service.kind), "auth.db"),
      "AUTH_ISSUER=http://issuer.test",
      "AUTH_APP_USERNAME=app",
      ...(options.quotedBcryptEnv ? [
        `AUTH_ADMIN_PASSWORD_BCRYPT='${TEST_APP_SERVER_BCRYPT}'`,
        `AUTH_APP_MASTER_PASSWORD_BCRYPT='${TEST_APP_SERVER_BCRYPT}'`
      ] : [])
    ].join("\n") + "\n",
    "utf8"
  );
  if (isWindows) {
    const setupScriptLines = [
        "param([string]$mode, [string]$db, [string]$out, [string]$publicOut)",
        ...(options.quotedBcryptEnv ? [
          `$expected = '${TEST_APP_SERVER_BCRYPT.replace(/'/g, "''")}'`,
          "if ($env:AUTH_ADMIN_PASSWORD_BCRYPT -ne $expected) {",
          "  [Console]::Error.WriteLine('bad admin bcrypt env')",
          "  exit 1",
          "}",
          "if ($env:AUTH_APP_MASTER_PASSWORD_BCRYPT -ne $expected) {",
          "  [Console]::Error.WriteLine('bad app master bcrypt env')",
          "  exit 1",
          "}"
        ] : []),
        "New-Item -ItemType Directory -Path (Split-Path -Parent $publicOut) -Force | Out-Null",
        "[System.IO.File]::WriteAllText($publicOut, \"APP_SERVER_PUBLIC_KEY`n\")"
    ];
    fs.writeFileSync(
      path.join(programDir, "scripts", "setup-public-key.ps1"),
      setupScriptLines.join("\r\n"),
      "utf8"
    );

    const issueScriptLines = [
      "param([string]$db, [string]$issuer, [string]$username, [string]$deviceName)"
    ];
    if (options.lockedIssueAttempts) {
      const markerPath = path.join(root, "issue-attempts.txt");
      issueScriptLines.push(
        `$marker = '${markerPath.replace(/'/g, "''")}'`,
        "$attempt = 0",
        "if (Test-Path -LiteralPath $marker) {",
        "  $attempt = [int](Get-Content -LiteralPath $marker -Raw)",
        "}",
        "$attempt += 1",
        "[System.IO.File]::WriteAllText($marker, $attempt)",
        `if ($attempt -le ${options.lockedIssueAttempts}) {`,
        "  [Console]::Error.WriteLine('Error: stepping, database is locked (5)')",
        "  exit 1",
        "}"
      );
    }
    if (options.issueCounterPath) {
      const counterPath = options.issueCounterPath;
      issueScriptLines.push(
        `$counter = '${counterPath.replace(/'/g, "''")}'`,
        "$count = 0",
        "if (Test-Path -LiteralPath $counter) {",
        "  $count = [int](Get-Content -LiteralPath $counter -Raw)",
        "}",
        "$count += 1",
        "[System.IO.File]::WriteAllText($counter, $count)"
      );
    }
    issueScriptLines.push(
      "Write-Output 'eyJhbGciOiJSUzI1NiIsImtpZCI6ImZpeHR1cmUiLCJ0eXAiOiJKV1QifQ.eyJpc3MiOiJodHRwOi8vaXNzdWVyLnRlc3QiLCJzdWIiOiJhcHAiLCJzY29wZSI6ImFwcCIsImRldmljZV9pZCI6ImRldmljZS0xIn0.signature'"
    );

    fs.writeFileSync(
      path.join(programDir, "scripts", "issue-bridge-access-token.ps1"),
      issueScriptLines.join("\r\n") + "\r\n",
      "utf8"
    );
  } else {
    fs.writeFileSync(
      path.join(programDir, "scripts", "setup-public-key.sh"),
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        ...(options.quotedBcryptEnv ? [
          `expected='${TEST_APP_SERVER_BCRYPT}'`,
          "if [ \"${AUTH_ADMIN_PASSWORD_BCRYPT:-}\" != \"$expected\" ]; then",
          "  printf '%s\\n' 'bad admin bcrypt env' >&2",
          "  exit 1",
          "fi",
          "if [ \"${AUTH_APP_MASTER_PASSWORD_BCRYPT:-}\" != \"$expected\" ]; then",
          "  printf '%s\\n' 'bad app master bcrypt env' >&2",
          "  exit 1",
          "fi"
        ] : []),
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
    const issueScriptLines = [
      "#!/usr/bin/env bash",
      "set -euo pipefail"
    ];
    if (options.lockedIssueAttempts) {
      const markerPath = path.join(root, "issue-attempts.txt");
      issueScriptLines.push(
        `marker=${JSON.stringify(markerPath)}`,
        "attempt=0",
        "if [ -f \"$marker\" ]; then",
        "  attempt=$(cat \"$marker\")",
        "fi",
        "attempt=$((attempt + 1))",
        "printf '%s' \"$attempt\" > \"$marker\"",
        `if [ "$attempt" -le ${options.lockedIssueAttempts} ]; then`,
        "  printf '%s\\n' 'Error: stepping, database is locked (5)' >&2",
        "  exit 1",
        "fi"
      );
    }
    if (options.issueCounterPath) {
      issueScriptLines.push(
        `counter=${JSON.stringify(options.issueCounterPath)}`,
        "count=0",
        "if [ -f \"$counter\" ]; then",
        "  count=$(cat \"$counter\")",
        "fi",
        "count=$((count + 1))",
        "printf '%s' \"$count\" > \"$counter\""
      );
    }
    issueScriptLines.push(
      "printf '%s\\n' 'eyJhbGciOiJSUzI1NiIsImtpZCI6ImZpeHR1cmUiLCJ0eXAiOiJKV1QifQ.eyJpc3MiOiJodHRwOi8vaXNzdWVyLnRlc3QiLCJzdWIiOiJhcHAiLCJzY29wZSI6ImFwcCIsImRldmljZV9pZCI6ImRldmljZS0xIn0.signature'"
    );
    fs.writeFileSync(
      path.join(programDir, "scripts", "issue-bridge-access-token.sh"),
      issueScriptLines.join("\n") + "\n",
      "utf8"
    );
    fs.chmodSync(path.join(programDir, "scripts", "setup-public-key.sh"), 0o755);
    fs.chmodSync(path.join(programDir, "scripts", "issue-bridge-access-token.sh"), 0o755);
  }
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
    const publicKeyPath = path.join(getServiceDataRoot(app, "zenmind-app-server"), "keys", "publicKey.pem");
    assert.equal(
      fs.readFileSync(publicKeyPath, "utf8"),
      "APP_SERVER_PUBLIC_KEY\n"
    );
  } finally {
    registryInternals.clearServices();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("issueAgentAccessToken passes unquoted bcrypt env values to app-server auth scripts", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-agent-auth-"));
  const app = createAppStub(tempRoot);
  registerAppServerFixture(tempRoot, { quotedBcryptEnv: true });

  try {
    const result = await issueAgentAccessToken(app, "missing");
    assert.equal(result.ok, true, result.message);
    assert.match(result.token, /^.+\..+\..+$/);
  } finally {
    registryInternals.clearServices();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("resolveAppServerCommand prefers auth helper scripts when backend binary is installed", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-agent-auth-"));
  const app = createAppStub(tempRoot);
  registerAppServerFixture(tempRoot, { includeBackendBinary: true });

  try {
    const layout = appServerAuthInternals.getAppServerLayout(app);
    const setupCommand = appServerAuthInternals.resolveAppServerCommand(layout, "setup-public-key");
    const issueCommand = appServerAuthInternals.resolveAppServerCommand(layout, "issue-bridge-access-token");

    if (process.platform === "win32") {
      assert.ok(setupCommand.args.some((arg) => arg.endsWith(path.join("scripts", "setup-public-key.ps1"))));
      assert.ok(issueCommand.args.some((arg) => arg.endsWith(path.join("scripts", "issue-bridge-access-token.ps1"))));
    } else {
      assert.ok(setupCommand.command.endsWith(path.join("scripts", "setup-public-key.sh")));
      assert.ok(issueCommand.command.endsWith(path.join("scripts", "issue-bridge-access-token.sh")));
    }
  } finally {
    registryInternals.clearServices();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("issueAgentAccessToken deduplicates concurrent app-server token requests", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-agent-auth-"));
  const app = createAppStub(tempRoot);
  const counterPath = path.join(tempRoot, "issue-count.txt");
  registerAppServerFixture(tempRoot, { issueCounterPath: counterPath });

  try {
    const results = await Promise.all([
      issueAgentAccessToken(app, "missing"),
      issueAgentAccessToken(app, "missing"),
      issueAgentAccessToken(app, "missing"),
      issueAgentAccessToken(app, "missing")
    ]);

    assert.equal(results.every((result) => result.ok), true);
    assert.equal(fs.readFileSync(counterPath, "utf8"), "1");

    const cached = await issueAgentAccessToken(app, "missing");
    assert.equal(cached.ok, true);
    assert.equal(fs.readFileSync(counterPath, "utf8"), "1");

    const refreshed = await issueAgentAccessToken(app, "unauthorized");
    assert.equal(refreshed.ok, true);
    assert.equal(fs.readFileSync(counterPath, "utf8"), "2");
  } finally {
    registryInternals.clearServices();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("issueAgentAccessToken retries transient sqlite busy errors from app-server scripts", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-agent-auth-"));
  const app = createAppStub(tempRoot);
  registerAppServerFixture(tempRoot, { lockedIssueAttempts: 2 });

  try {
    const result = await issueAgentAccessToken(app, "missing");
    assert.equal(result.ok, true);
    assert.match(result.token, /^.+\..+\..+$/);
    assert.equal(fs.readFileSync(path.join(tempRoot, "issue-attempts.txt"), "utf8"), "3");
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
