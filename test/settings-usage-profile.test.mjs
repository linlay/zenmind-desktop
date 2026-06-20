import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { getDesktopUsageProfile } = require("../dist-electron/main/usage-profile.js");

function createTempDir(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeText(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function createMockApp(homeDir) {
  return {
    getPath(name) {
      if (name === "home") {
        return homeDir;
      }
      return homeDir;
    }
  };
}

function withRegistriesDir(t, registriesDir) {
  const previousRegistriesDir = process.env.REGISTRIES_DIR;
  const previousAgentPlatformRegistriesDir = process.env.AGENT_PLATFORM_REGISTRIES_DIR;
  process.env.REGISTRIES_DIR = registriesDir;
  delete process.env.AGENT_PLATFORM_REGISTRIES_DIR;
  t.after(() => {
    if (previousRegistriesDir === undefined) {
      delete process.env.REGISTRIES_DIR;
    } else {
      process.env.REGISTRIES_DIR = previousRegistriesDir;
    }
    if (previousAgentPlatformRegistriesDir === undefined) {
      delete process.env.AGENT_PLATFORM_REGISTRIES_DIR;
    } else {
      process.env.AGENT_PLATFORM_REGISTRIES_DIR = previousAgentPlatformRegistriesDir;
    }
  });
}

function startTransitHubMock(t, handler) {
  const server = http.createServer(handler);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert.equal(typeof address, "object");
      t.after(() => server.close());
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function jsonResponse(response, statusCode, payload) {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

test("usage profile loads Transit Hub self-inspection data without exposing api keys", async (t) => {
  const root = createTempDir(t, "zenmind-usage-profile-");
  const registriesDir = path.join(root, "registries");
  withRegistriesDir(t, registriesDir);

  const requestedPaths = [];
  const transitBaseUrl = await startTransitHubMock(t, (request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    requestedPaths.push(requestUrl.pathname);
    assert.equal(request.headers.authorization, "Bearer dk_test_secret");

    if (requestUrl.pathname === "/api/me") {
      jsonResponse(response, 200, {
        id: "key-1",
        name: "Desktop Key",
        description: "",
        key_prefix: "dk_live",
        source: "desktop",
        status: "active",
        forced_expired: false,
        request_quota: 0,
        token_quota: 0,
        allowed_models: ["th-deepseek-v4-flash"],
        rate_limits: [{ window: "5h", request_quota: 0, token_quota: 1000000, cost_quota_micro: 0 }],
        used_requests: 12,
        used_tokens: 3456,
        created_at: "2026-06-01T00:00:00Z",
        updated_at: "2026-06-20T00:00:00Z"
      });
      return;
    }
    if (requestUrl.pathname === "/api/me/limits") {
      jsonResponse(response, 200, {
        lifetime: {
          requests: 12,
          request_quota: 0,
          request_remaining: 0,
          tokens: 3456,
          token_quota: 0,
          token_remaining: 0
        },
        rate_limit_usage: [{
          window: "5h",
          starts_at: "2026-06-20T08:00:00Z",
          resets_at: "2026-06-20T13:00:00Z",
          requests: 4,
          request_quota: 0,
          request_remaining: 0,
          tokens: 360,
          token_quota: 1000,
          token_remaining: 640,
          cost_micro: 0,
          cost_quota_micro: 0,
          cost_remaining_micro: 0
        }]
      });
      return;
    }
    if (requestUrl.pathname === "/api/me/usage") {
      assert.equal(requestUrl.searchParams.get("bucket"), "day");
      jsonResponse(response, 200, {
        summary: {
          bucket: "",
          requests: 3,
          request_tokens: 120,
          response_tokens: 680,
          total_tokens: 800,
          cache_hit_tokens: 0,
          cache_miss_tokens: 0,
          cache_total_tokens: 0,
          cache_hit_rate: null,
          cost_micro: 1200,
          error_requests: 0,
          average_latency_ms: 410
        },
        items: [{
          bucket: "2026-06-20T00:00:00Z",
          requests: 3,
          request_tokens: 120,
          response_tokens: 680,
          total_tokens: 800,
          cache_hit_tokens: 0,
          cache_miss_tokens: 0,
          cache_total_tokens: 0,
          cache_hit_rate: null,
          cost_micro: 1200,
          error_requests: 0,
          average_latency_ms: 410
        }]
      });
      return;
    }
    if (requestUrl.pathname === "/api/me/balance") {
      jsonResponse(response, 200, {
        currency: "USD",
        cost_micro: 1200,
        unlimited: false,
        items: [{
          window: "7d",
          starts_at: "2026-06-20T00:00:00Z",
          resets_at: "2026-06-27T00:00:00Z",
          requests: 0,
          request_quota: 0,
          request_remaining: 0,
          tokens: 0,
          token_quota: 0,
          token_remaining: 0,
          cost_micro: 1200,
          cost_quota_micro: 1000000,
          cost_remaining_micro: 998800
        }]
      });
      return;
    }
    if (requestUrl.pathname === "/api/me/logs") {
      jsonResponse(response, 200, {
        items: [{
          id: 1,
          api_key_id: "key-1",
          api_key_name: "Desktop Key",
          protocol: "openai",
          public_model: "th-deepseek-v4-flash",
          upstream_model: "deepseek-chat",
          provider: "deepseek",
          pool: "default",
          account: "",
          device_id: "mac-1",
          source: "desktop",
          status_code: 200,
          latency_ms: 410,
          request_tokens: 120,
          response_tokens: 680,
          total_tokens: 800,
          cache_hit_tokens: 0,
          cache_miss_tokens: 0,
          cache_total_tokens: 0,
          cache_hit_rate: null,
          cost_micro: 1200,
          estimated: false,
          error_type: "",
          created_at: "2026-06-20T10:00:00Z"
        }],
        total: 1,
        limit: 500,
        offset: 0
      });
      return;
    }
    if (requestUrl.pathname === "/api/me/sessions") {
      jsonResponse(response, 200, {
        items: [{
          api_key_id: "key-1",
          api_key_name: "Desktop Key",
          key_prefix: "dk_live",
          device_id: "mac-1",
          source: "desktop",
          first_seen_at: "2026-06-20T09:00:00Z",
          last_seen_at: "2026-06-20T10:00:00Z",
          active: true,
          last_status_code: 200,
          request_count: 3,
          token_count: 800
        }],
        total: 1,
        limit: 500,
        offset: 0
      });
      return;
    }
    if (requestUrl.pathname === "/api/me/prices") {
      jsonResponse(response, 200, {
        items: [{
          id: "price-1",
          protocol: "openai",
          public_model: "th-deepseek-v4-flash",
          input_cost_micro_per_1m_tokens: 1000,
          input_cache_hit_cost_micro_per_1m_tokens: null,
          output_cost_micro_per_1m_tokens: 2000,
          currency: "USD",
          created_at: "2026-06-01T00:00:00Z",
          updated_at: "2026-06-01T00:00:00Z"
        }]
      });
      return;
    }

    jsonResponse(response, 404, { error: "not found" });
  });

  writeText(path.join(registriesDir, "providers", "openai.yml"), [
    "key: openai",
    `baseUrl: ${transitBaseUrl}`,
    "apiKey: dk_test_secret",
    "defaultModel: th-deepseek-v4-flash",
    ""
  ].join("\n"));
  writeText(path.join(registriesDir, "providers", "th-copy.yml"), [
    "key: th-copy",
    `baseUrl: ${transitBaseUrl}`,
    "apiKey: dk_test_secret",
    "defaultModel: th-deepseek-v4-flash",
    ""
  ].join("\n"));

  const result = await getDesktopUsageProfile(createMockApp(root), {
    now: new Date("2026-06-20T12:00:00Z")
  });

  assert.equal(result.ok, true);
  assert.equal(result.currentKey.name, "Desktop Key");
  assert.equal(result.usage.summary.total_tokens, 800);
  assert.equal(result.balance.items[0].cost_remaining_micro, 998800);
  assert.equal(result.logs.items[0].public_model, "th-deepseek-v4-flash");
  assert.equal(result.sessions.items[0].device_id, "mac-1");
  assert.equal(result.prices.items[0].public_model, "th-deepseek-v4-flash");
  assert.equal(JSON.stringify(result).includes("dk_test_secret"), false);
  assert.equal(requestedPaths.filter((item) => item === "/api/me").length, 1);
});

test("usage profile returns a clear empty state when no provider is configured", async (t) => {
  const root = createTempDir(t, "zenmind-usage-profile-empty-");
  const registriesDir = path.join(root, "registries");
  withRegistriesDir(t, registriesDir);

  const result = await getDesktopUsageProfile(createMockApp(root), {
    now: new Date("2026-06-20T12:00:00Z"),
    fetchImpl: async () => {
      throw new Error("fetch should not be called without providers");
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "not-configured");
  assert.match(result.message, /provider|Transit Hub|自查/u);
});
