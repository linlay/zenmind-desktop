import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const source = path.join(root, "src/shared/contracts/agent-webclient-bridge.ts");
const mirror = path.join(root, "contracts/agent-webclient/agent-webclient-bridge.ts");

test("Agent WebClient contract mirror is deterministic and versioned", () => {
  const canonical = fs.readFileSync(source, "utf8").replace(/\r\n/gu, "\n").trimEnd();
  const digest = crypto.createHash("sha256").update(canonical).digest("hex");
  const generated = fs.readFileSync(mirror, "utf8").replace(/\r\n/gu, "\n");
  assert.match(generated, new RegExp(`^// Generated[\\s\\S]*// sha256:${digest}\\n`, "u"));
  assert.match(canonical, /AGENT_WEBCLIENT_BRIDGE_VERSION = 6 as const/u);
  assert.match(canonical, /AGENT_WEBCLIENT_PLATFORM_FRAME_PORT_TRANSPORT_VERSION = 2 as const/u);
  assert.match(canonical, /"version_mismatch"/u);
  assert.match(canonical, /openResource\(input: WorkPanelOpenResourceInput\)/u);
  assert.match(canonical, /openDocument\(input: WorkPanelOpenDocumentInput\)/u);
  assert.match(canonical, /renderer: "native-image"/u);
  assert.match(canonical, /renderer: "native-html" \| "native-image"/u);
  assert.equal(spawnSync(process.execPath, ["scripts/generate-agent-webclient-contract.mjs", "--check"], {
    cwd: root,
  }).status, 0);
});

test("Agent WebClient contract check fails when canonical changes without its mirror", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-contract-check-"));
  try {
    fs.mkdirSync(path.join(temporary, "scripts"), { recursive: true });
    fs.mkdirSync(path.join(temporary, "src/shared/contracts"), { recursive: true });
    fs.mkdirSync(path.join(temporary, "contracts/agent-webclient"), { recursive: true });
    fs.copyFileSync(path.join(root, "scripts/generate-agent-webclient-contract.mjs"), path.join(temporary, "scripts/generate-agent-webclient-contract.mjs"));
    fs.copyFileSync(source, path.join(temporary, "src/shared/contracts/agent-webclient-bridge.ts"));
    fs.copyFileSync(mirror, path.join(temporary, "contracts/agent-webclient/agent-webclient-bridge.ts"));
    fs.appendFileSync(path.join(temporary, "src/shared/contracts/agent-webclient-bridge.ts"), "\n// canonical changed\n");
    const result = spawnSync(process.execPath, ["scripts/generate-agent-webclient-contract.mjs", "--check"], {
      cwd: temporary,
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /contract is stale/u);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("Agent WebClient contract check accepts a CRLF mirror", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-contract-crlf-"));
  try {
    fs.mkdirSync(path.join(temporary, "scripts"), { recursive: true });
    fs.mkdirSync(path.join(temporary, "src/shared/contracts"), { recursive: true });
    fs.mkdirSync(path.join(temporary, "contracts/agent-webclient"), { recursive: true });
    fs.copyFileSync(path.join(root, "scripts/generate-agent-webclient-contract.mjs"), path.join(temporary, "scripts/generate-agent-webclient-contract.mjs"));
    fs.copyFileSync(source, path.join(temporary, "src/shared/contracts/agent-webclient-bridge.ts"));
    const crlfMirror = fs.readFileSync(mirror, "utf8").replace(/\r\n/gu, "\n").replace(/\n/gu, "\r\n");
    fs.writeFileSync(path.join(temporary, "contracts/agent-webclient/agent-webclient-bridge.ts"), crlfMirror, "utf8");
    const result = spawnSync(process.execPath, ["scripts/generate-agent-webclient-contract.mjs", "--check"], {
      cwd: temporary,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
