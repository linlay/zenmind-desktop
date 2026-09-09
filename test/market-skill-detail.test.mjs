import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { readMarketSkillContent } = require("../dist-electron/main/modules/marketplace/skill-detail.js");
const { registerMarketplaceIpcHandlers } = require("../dist-electron/main/modules/marketplace/ipc.js");
const apiBaseUrl = "https://example.invalid/market/api/v1";
const app = {};

test("skill docs use only fixed public endpoint without token, cookies or identity fields", async () => {
  const calls = [];
  let authCalls = 0;
  const result = await readMarketSkillContent(app, "demo-skill", {
    apiBaseUrl,
    issueMarketAccessToken: async () => { authCalls += 1; throw new Error("must not ask for auth"); },
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ content: "# Demo\nSkill documentation", token: "unrelated" }));
    }
  });
  assert.deepEqual(result, { content: "# Demo\nSkill documentation" });
  assert.equal(authCalls, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${apiBaseUrl}/skills/demo-skill/skill-md`);
  assert.equal(calls[0].init.credentials, "omit");
  assert.equal(calls[0].init.redirect, "error");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.headers, undefined);
  assert.ok(calls[0].init.signal instanceof AbortSignal);
});

test("invalid IDs and disabled market fail before network access", async () => {
  let requests = 0;
  const options = { apiBaseUrl, fetchImpl: async () => { requests += 1; return new Response("{}"); } };
  for (const id of ["", "..", "../x", "x/y", "x\\y", "x?token=secret", "x#fragment", "x%2fy", "a".repeat(201), {}, undefined]) {
    await assert.rejects(readMarketSkillContent(app, id, options), /market_skill_content_invalid_id/);
  }
  await assert.rejects(readMarketSkillContent(app, "demo", { ...options, marketEnabled: false }), /market_skill_content_unavailable/);
  assert.equal(requests, 0);
});

test("invalid, empty, failed and private responses never leak upstream errors", async () => {
  const cases = [
    [new Response("{broken"), "unavailable"],
    [new Response(JSON.stringify({ content: 22 })), "invalid_response"],
    [new Response(JSON.stringify({ content: "  " })), "empty"],
    [new Response("Bearer secret /private/path", { status: 401 }), "unavailable"],
    [new Response("Bearer secret /private/path", { status: 500 }), "unavailable"]
  ];
  for (const [response, code] of cases) {
    await assert.rejects(readMarketSkillContent(app, "demo", { apiBaseUrl, fetchImpl: async () => response }),
      (error) => error.message === `market_skill_content_${code}` && !/secret|private/.test(error.message));
  }
});

test("oversized declared and streamed responses are bounded", async () => {
  const big = JSON.stringify({ content: "a".repeat(256 * 1024) });
  for (const headers of [{}, { "Content-Length": String(256 * 1024 + 10) }]) {
    await assert.rejects(readMarketSkillContent(app, "demo", {
      apiBaseUrl, fetchImpl: async () => new Response(big, { headers })
    }), /market_skill_content_unavailable/);
  }
});

test("IPC rejects foreign windows and subframes before reading configured Market", async () => {
  const handlers = new Map();
  const frame = {};
  const webContents = { mainFrame: frame, isDestroyed: () => false };
  registerMarketplaceIpcHandlers({ handle: (channel, fn) => handlers.set(channel, fn) }, {
    app,
    mainWindow: { webContents, isDestroyed: () => false }
  });
  const read = handlers.get("market.readSkillContent");
  await assert.rejects(read({ sender: {}, senderFrame: frame }, "demo"), /market_skill_content_forbidden/);
  await assert.rejects(read({ sender: webContents, senderFrame: {} }, "demo"), /market_skill_content_forbidden/);
});
