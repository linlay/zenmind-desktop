import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { issueAgentAccessToken } = require("../dist-electron/main/agent-auth.js");

function createAppStub(userDataRoot) {
  return {
    getPath(name) {
      assert.equal(name, "userData");
      return userDataRoot;
    }
  };
}

function decodeJson(part) {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

test("issueAgentAccessToken signs a desktop-app jwt using the shared rsa key", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-agent-auth-"));
  const app = createAppStub(tempRoot);

  try {
    const result = await issueAgentAccessToken(app, "missing");
    assert.equal(result.ok, true);
    assert.match(result.token, /^.+\..+\..+$/);
    const [, payloadPart] = result.token.split(".");
    assert.equal(decodeJson(payloadPart).sub, "desktop-app");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("issueAgentAccessToken produces a fresh token for repeated refreshes", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-agent-auth-"));
  const app = createAppStub(tempRoot);

  try {
    const first = await issueAgentAccessToken(app, "unauthorized");
    const second = await issueAgentAccessToken(app, "unauthorized");
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.notEqual(second.token, first.token);
    const [, firstPayloadPart] = first.token.split(".");
    const [, secondPayloadPart] = second.token.split(".");
    assert.notEqual(decodeJson(secondPayloadPart).jti, decodeJson(firstPayloadPart).jti);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
