import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const compile = (text) => ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const parse = (path) => ts.createSourceFile(path, fs.readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);

test("assembly binds the capability resolver once for both Desktop WS entry points", async () => {
  const assembly = parse("src/main/app/assembly/assistant.ts");
  const implementation = assembly.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "assembleAssistantIntegration");
  assert.ok(implementation);
  const app = {};
  const resolver = () => {};
  const context = {
    exports: {},
    createAssistantIntegrationPorts: (ports) => ports,
    ensureIdentityCenterJwk: async (targetApp, targetResolver) => {
      assert.equal(targetApp, app);
      assert.equal(targetResolver, resolver);
      return { publicKeyPem: "resolved-public-key" };
    }
  };
  // Supply unused integration ports without loading Electron or starting services.
  const portObject = implementation.body.statements[0].expression.arguments[0];
  for (const property of portObject.properties) {
    if (ts.isShorthandPropertyAssignment(property)) context[property.name.text] = () => {};
  }
  vm.createContext(context);
  vm.runInContext(compile(implementation.getText(assembly)), context);
  const ports = context.exports.assembleAssistantIntegration({
    servicesFacade: { resolveDesktopCapability: resolver },
    websFacade: { webappRuntime: {} }
  });
  assert.equal((await ports.ensureIdentityCenterJwk(app)).publicKeyPem, "resolved-public-key");

  const runtime = parse("src/main/modules/assistant/runtime.ts");
  const createRuntime = runtime.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "createAssistantBridgeRuntime");
  assert.ok(createRuntime);
  let localOptions;
  let tunnelOptions;
  ports.createDesktopActionOptions = () => ({});
  ports.setWebappPublicationChangeListener = () => {};
  ports.createKanbanRuntime = () => ({ start() {} });
  ports.startDesktopWsServer = async (options) => { localOptions = options; return { running: true }; };
  ports.configureTunnelHubRuntime = (options) => { tunnelOptions = options.desktopWsServerOptions; };
  const runtimeContext = {
    exports: {}, console,
    AwcpGuestBridge: class {},
    AgentPlatformAssistantBridge: class {},
    AssistantNavigationStatusClient: class { start() {} }
  };
  vm.createContext(runtimeContext);
  vm.runInContext(compile(createRuntime.getText(runtime)), runtimeContext);
  const bridge = runtimeContext.exports.createAssistantBridgeRuntime({
    integrationPorts: ports, app, desktopAppInfo: {},
    realtimeBroker: { setDesktopBridgeProvider() {} },
    cdpIntegration: { start() {} }
  });
  bridge.start();
  await bridge.startDesktopWsServerForSettings({ port: 1234 });
  assert.equal(tunnelOptions, bridge.desktopWsServerOptions);
  assert.equal(localOptions.ensureIdentityCenterJwk, ports.ensureIdentityCenterJwk);
  assert.equal(tunnelOptions.ensureIdentityCenterJwk, ports.ensureIdentityCenterJwk);
  assert.equal((await localOptions.ensureIdentityCenterJwk(app)).publicKeyPem, "resolved-public-key");
  assert.equal((await tunnelOptions.ensureIdentityCenterJwk(app)).publicKeyPem, "resolved-public-key");
});


test("the built-in WS authenticator accepts a signed token and rejects an invalid token normally", async (t) => {
  const require = createRequire(import.meta.url);
  const { startDesktopWsServer, stopDesktopWsServer, authenticateDesktopWsProtocolSession } = require("../dist-electron/main/modules/desktop-protocol/ws-server.js");
  const { getDesktopDeviceId } = require("../dist-electron/main/modules/identity/index.js");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "zenmind-ws-auth-wiring-"));
  t.after(async () => { await stopDesktopWsServer(); fs.rmSync(home, { recursive: true, force: true }); });
  const app = { getPath: (name) => name === "appData" ? path.join(home, "app-data") : home };
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });
  const payload = { sub: "app", scope: "app", device_id: getDesktopDeviceId(app), exp: Math.floor(Date.now() / 1000) + 3600 };
  const encoded = [ { alg: "RS256", typ: "JWT" }, payload ].map((part) => Buffer.from(JSON.stringify(part)).toString("base64url")).join(".");
  const token = `${encoded}.${crypto.sign("RSA-SHA256", Buffer.from(encoded), privateKey).toString("base64url")}`;
  let resolutions = 0;
  const options = {
    app, host: "127.0.0.1", port: 0,
    ensureIdentityCenterJwk: async (targetApp) => { assert.equal(targetApp, app); resolutions++; return { publicKeyPem }; },
    desktopActionOptions: {}, assistantBridge: { listAgents: async () => [] },
    getKanbanRuntime: () => null, logger: { log() {}, warn() {}, error() {} }
  };
  // The tunnel endpoint uses this same authenticator with the shared options.
  assert.equal((await authenticateDesktopWsProtocolSession(options, token)).deviceId, payload.device_id);
  await assert.rejects(authenticateDesktopWsProtocolSession(options, "invalid-token"), /invalid JWT/);
  const started = await startDesktopWsServer(options);
  const client = new WebSocket(`${started.webSocketUrl}?token=${token}`);
  t.after(() => { if (client.readyState !== WebSocket.CLOSED) client.close(); });
  await once(client, "open");
  const response = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("session.hello timed out")), 2000);
    const receive = (event) => {
      const frame = JSON.parse(event.data);
      if (frame.id !== "hello") return;
      clearTimeout(timer); client.removeEventListener("message", receive); resolve(frame);
    };
    client.addEventListener("message", receive);
  });
  client.send(JSON.stringify({ v: 1, ns: "d", frame: "request", type: "session.hello", id: "hello" }));
  const hello = await response;
  assert.equal(hello.code, 0);
  assert.equal(hello.data.deviceId, payload.device_id);
  client.close();
  await once(client, "close");
  const url = new URL(started.webSocketUrl); url.protocol = "http:"; url.searchParams.set("token", "invalid-token");
  const rejection = await new Promise((resolve, reject) => {
    const request = http.get(url, { headers: { Upgrade: "websocket", Connection: "Upgrade", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": crypto.randomBytes(16).toString("base64") } });
    request.on("response", (response) => { let body = ""; response.on("data", (chunk) => { body += chunk; }); response.on("end", () => resolve({ status: response.statusCode, body })); });
    request.on("error", reject);
  });
  assert.equal(rejection.status, 401);
  assert.match(rejection.body, /Unauthorized/);
  assert.doesNotMatch(rejection.body, /is not a function/);
  assert.equal(resolutions, 4);
});
