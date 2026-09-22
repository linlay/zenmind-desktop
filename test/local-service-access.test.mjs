import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

function load(relativePath) {
  const source = fs.readFileSync(new URL(relativePath, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  const module = { exports: {} };
  new Function("module", "exports", compiled)(module, module.exports);
  return module.exports;
}
const { localServiceBaseUrl, platformConnectionExamples } = load("../src/renderer/pages/settings/localServiceAccess.ts");
const { createSettingsSectionDefinitions } = load("../src/renderer/settingsPageSections.ts");
const { resolveSettingsSectionId } = load("../src/shared/settings-routes.ts");
const state = (status, port) => ({ status, healthMeta: { port, webUrl: "https://example.com/secret?token=private" } });

test("configured endpoints remain visible while stopped and follow the actual port", () => {
  assert.equal(localServiceBaseUrl(state("running", 11949)), "http://127.0.0.1:11949");
  assert.equal(localServiceBaseUrl(undefined), "");
  for (const status of ["stopped", "error", "not-installed", "config-required", "dependency-missing", "initialization-required"]) {
    assert.equal(localServiceBaseUrl(state(status, 11949)), "http://127.0.0.1:11949");
  }
  for (const port of [null, undefined, 0, -1, 65536, 4.5, NaN, "11949"]) {
    assert.equal(localServiceBaseUrl(state("running", port)), "");
  }
});

test("HTTP examples use platform-specific commands and never include the service webUrl", () => {
  for (const isWindows of [false, true]) {
    const examples = platformConnectionExamples(localServiceBaseUrl(state("running", 11949)), isWindows);
    assert.ok(examples.http.startsWith(isWindows ? "curl.exe " : "curl "));
    assert.ok(examples.http.includes("http://127.0.0.1:11949/api/agents"));
    assert.equal(examples.wsUrl, "ws://127.0.0.1:11949/ws");
    assert.ok(!JSON.stringify(examples).includes("private"));
  }
});

test("WS example waits for the v2 handshake, reads once, and closes without token URLs", () => {
  const { websocket } = platformConnectionExamples("http://127.0.0.1:11949", false);
  const sent = [];
  let closed = false;
  let instance;
  class WebSocket {
    constructor(url, protocols) { instance = this; assert.equal(url, "ws://127.0.0.1:11949/ws"); assert.deepEqual(protocols, ["bearer.YOUR_ACCESS_TOKEN"]); }
    send(data) { sent.push(JSON.parse(data)); }
    close() { closed = true; }
  }
  new Function("WebSocket", "setTimeout", "clearTimeout", "console", websocket)(WebSocket, () => 1, () => {}, { log() {}, error() {} });
  assert.equal(sent.length, 0);
  instance.onmessage({ data: JSON.stringify({ frame: "push", type: "connected", data: { protocolVersion: 2 } }) });
  assert.deepEqual(sent, [{ frame: "request", type: "/api/agents", id: "agents-1", payload: {} }]);
  instance.onmessage({ data: JSON.stringify({ frame: "response", id: "agents-1", code: 200 }) });
  assert.equal(closed, true);
});

test("local services is reachable in settings on both desktop platforms", () => {
  for (const isWindows of [false, true]) {
    const sections = createSettingsSectionDefinitions({ isWindows }).filter((entry) => entry.visible);
    assert.equal(resolveSettingsSectionId("/settings/localServices", sections.map((entry) => entry.id)), "localServices");
  }
});


test("copied examples include a valid token and its expiration on both platforms", () => {
  const exp = Math.floor(Date.now() / 1000) + 300;
  const token = `header.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.signature`;
  for (const isWindows of [false, true]) {
    const examples = platformConnectionExamples("http://127.0.0.1:11949", isWindows, token);
    assert.ok(examples.http.includes(`Authorization: Bearer ${token}`));
    assert.ok(examples.websocket.includes(JSON.stringify(token)));
    assert.equal(examples.expiresAtMs, exp * 1000);
  }
});

test("examples reject expired, missing-expiry and shell-unsafe tokens", () => {
  const jwt = claims => `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
  for (const token of [jwt({ exp: 1 }), jwt({}), jwt({ exp: "9999999999" }), 'bad.$(command).signature', 'bad.`command`.signature']) {
    assert.throws(() => platformConnectionExamples("http://127.0.0.1:11949", false, token));
    assert.throws(() => platformConnectionExamples("http://127.0.0.1:11949", true, token));
  }
});
