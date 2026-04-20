import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const projectRoot = process.cwd();

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function loadAgentGatewayClient(windowMock, fetchMock = async () => new Response("{}")) {
  const sourcePath = path.join(projectRoot, "src", "renderer", "services", "agentGatewayClient.ts");
  const source = fs.readFileSync(sourcePath, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;

  const module = { exports: {} };
  const context = vm.createContext({
    module,
    exports: module.exports,
    require,
    console,
    URL,
    FormData,
    Blob,
    URLSearchParams,
    ArrayBuffer,
    TextDecoder,
    Uint8Array,
    Response,
    window: windowMock,
    fetch: fetchMock,
    Date,
    Math,
  });

  vm.runInContext(transpiled, context, { filename: sourcePath });
  return module.exports;
}

function createService(overrides = {}) {
  return {
    id: "agent-webclient",
    name: "小宅助理",
    kind: "builtin",
    version: "v0.1.0",
    description: "",
    installDir: "",
    installed: true,
    status: "running",
    statusLabel: "运行中",
    message: "",
    frontendMode: "standalone",
    configFiles: [],
    healthMeta: {
      pid: 123,
      pidFilePath: "",
      logFilePath: "",
      errorLogFilePath: "",
      webUrl: "http://127.0.0.1:11948/",
      port: 11948,
      prerequisites: [],
    },
    ...overrides,
  };
}

function createWindowMock(options = {}) {
  const list = options.list ?? (async () => [createService()]);
  const start = options.start ?? (async () => ({
    ok: true,
    message: "started",
    service: createService({ healthMeta: { ...createService().healthMeta, webUrl: "http://127.0.0.1:11948" } }),
  }));
  const issueAccessToken = options.issueAccessToken ?? (async () => ({
    ok: true,
    token: "token-1",
    message: "ok",
  }));

  return {
    electronAPI: {
      services: {
        list,
        start,
      },
      agentAuth: {
        issueAccessToken,
      },
    },
  };
}

test("ensureAgentGateway returns running agent-webclient webUrl without starting", async () => {
  let startCalls = 0;
  const windowMock = createWindowMock({
    list: async () => [createService()],
    start: async () => {
      startCalls += 1;
      throw new Error("should not start");
    },
  });
  const { ensureAgentGateway } = loadAgentGatewayClient(windowMock);

  const gateway = await ensureAgentGateway();

  assert.equal(gateway.baseUrl, "http://127.0.0.1:11948");
  assert.equal(gateway.service.id, "agent-webclient");
  assert.equal(startCalls, 0);
});

test("ensureAgentGateway starts agent-webclient when it is not running", async () => {
  let startServiceId = "";
  const stoppedService = createService({
    status: "stopped",
    statusLabel: "已停止",
    healthMeta: { ...createService().healthMeta, webUrl: "" },
  });
  const runningService = createService({
    healthMeta: { ...createService().healthMeta, webUrl: "http://127.0.0.1:12000/" },
  });
  const windowMock = createWindowMock({
    list: async () => [stoppedService],
    start: async (serviceId) => {
      startServiceId = serviceId;
      return { ok: true, message: "started", service: runningService };
    },
  });
  const { ensureAgentGateway } = loadAgentGatewayClient(windowMock);

  const gateway = await ensureAgentGateway();

  assert.equal(startServiceId, "agent-webclient");
  assert.equal(gateway.baseUrl, "http://127.0.0.1:12000");
});

test("streamAgentQuery reports token issuance failures", async () => {
  const windowMock = createWindowMock({
    issueAccessToken: async () => ({
      ok: false,
      token: "",
      message: "token unavailable",
    }),
  });
  const { streamAgentQuery } = loadAgentGatewayClient(windowMock);

  await assert.rejects(
    () => streamAgentQuery({ message: "你好", onEvent: () => undefined }),
    /token unavailable/,
  );
});

test("streamAgentQuery parses SSE frames and fills type from event name", async () => {
  const fetchCalls = [];
  const fetchMock = async (url, init) => {
    fetchCalls.push([url, init]);
    return new Response(
      [
        'event: content.delta',
        'data: {"text":"hi"}',
        "",
        'data: {"type":"content.done","text":"done"}',
        "",
        "data: [DONE]",
        "",
      ].join("\n"),
      { status: 200 },
    );
  };
  const { streamAgentQuery } = loadAgentGatewayClient(createWindowMock(), fetchMock);
  const events = [];

  await streamAgentQuery({
    requestId: "req_1",
    message: "你好",
    agentKey: "zenmi",
    onEvent: (event) => events.push(event),
  });

  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0][0], "http://127.0.0.1:11948/api/query");
  assert.equal(fetchCalls[0][1].headers.Authorization, "Bearer token-1");
  assert.deepEqual(JSON.parse(fetchCalls[0][1].body), {
    requestId: "req_1",
    planningMode: false,
    message: "你好",
    agentKey: "zenmi",
  });
  assert.deepEqual(plain(events), [
    { text: "hi", type: "content.delta" },
    { type: "content.done", text: "done" },
  ]);
});

test("streamAgentQuery rejects invalid SSE JSON", async () => {
  const fetchMock = async () => new Response("data: not-json\n\n", { status: 200 });
  const { streamAgentQuery } = loadAgentGatewayClient(createWindowMock(), fetchMock);

  await assert.rejects(
    () => streamAgentQuery({ message: "你好", onEvent: () => undefined }),
    /SSE 事件解析失败/,
  );
});

test("requestAgentJson refreshes token once after 401", async () => {
  const tokenReasons = [];
  const windowMock = createWindowMock({
    issueAccessToken: async (reason) => {
      tokenReasons.push(reason);
      return {
        ok: true,
        token: reason === "unauthorized" ? "fresh-token" : "stale-token",
        message: "ok",
      };
    },
  });
  const fetchCalls = [];
  const fetchMock = async (url, init) => {
    fetchCalls.push([url, init]);
    if (fetchCalls.length === 1) {
      return new Response(JSON.stringify({ code: 401, msg: "unauthorized" }), {
        status: 401,
      });
    }
    return new Response(JSON.stringify({ code: 0, msg: "ok", data: [{ key: "zenmi" }] }), {
      status: 200,
    });
  };
  const { requestAgentJson } = loadAgentGatewayClient(windowMock, fetchMock);

  const result = await requestAgentJson("/api/agents");

  assert.deepEqual(tokenReasons, ["missing", "unauthorized"]);
  assert.equal(fetchCalls.length, 2);
  assert.equal(fetchCalls[0][1].headers.Authorization, "Bearer stale-token");
  assert.equal(fetchCalls[1][1].headers.Authorization, "Bearer fresh-token");
  assert.deepEqual(plain(result), { code: 0, msg: "ok", data: [{ key: "zenmi" }] });
});
