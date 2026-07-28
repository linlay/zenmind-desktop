import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const {
  ensureProviderRegisterApiKey,
  __testInternals: {
    SQLITE_BUSY_MAX_ATTEMPTS,
    clearProviderRegisterBackgroundRetries,
    isProviderRegisterSqliteBusyError,
    isTransientSqliteBusyResponse,
    providerRegisterBackgroundRetryDelayMs,
    providerRegisterRetryDelayMs,
    requestApiKey,
    resolveProviderRegisterPath
  }
} = require("../dist-electron/main/provider-register.js");

function response(status, body, statusText = "") {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    text: async () => body
  };
}

test("provider-register retries transient SQLite busy responses before applying the key", async () => {
  const replies = [
    response(500, '{"error":"database is locked (5) (SQLITE_BUSY)"}', "Internal Server Error"),
    response(503, '{"error":"database table is locked"}', "Service Unavailable"),
    response(200, '{"key":"dk_retry_succeeded"}', "OK")
  ];
  const delays = [];
  let fetchCalls = 0;

  const key = await requestApiKey({
    endpoint: "https://transit-hub.example/api/apply-apikey",
    token: "test-jwt",
    deviceId: "desktop-device",
    fetchImpl: async () => {
      const reply = replies[fetchCalls];
      fetchCalls += 1;
      return reply;
    },
    sleepImpl: async (delayMs) => {
      delays.push(delayMs);
    }
  });

  assert.equal(key, "dk_retry_succeeded");
  assert.equal(fetchCalls, 3);
  assert.deepEqual(delays, [250, 500]);
});

test("provider-register does not retry unrelated HTTP 500 responses", async () => {
  let fetchCalls = 0;
  const delays = [];

  await assert.rejects(
    requestApiKey({
      endpoint: "https://transit-hub.example/api/apply-apikey",
      token: "test-jwt",
      deviceId: "desktop-device",
      fetchImpl: async () => {
        fetchCalls += 1;
        return response(500, '{"error":"unexpected server failure"}', "Internal Server Error");
      },
      sleepImpl: async (delayMs) => {
        delays.push(delayMs);
      }
    }),
    /HTTP 500 Internal Server Error/u
  );

  assert.equal(fetchCalls, 1);
  assert.deepEqual(delays, []);
});

test("provider-register bounds persistent SQLite busy retries", async () => {
  let fetchCalls = 0;
  const delays = [];

  await assert.rejects(
    requestApiKey({
      endpoint: "https://transit-hub.example/api/apply-apikey",
      token: "test-jwt",
      deviceId: "desktop-device",
      fetchImpl: async () => {
        fetchCalls += 1;
        return response(500, '{"error":"database is locked (5) (SQLITE_BUSY)"}');
      },
      sleepImpl: async (delayMs) => {
        delays.push(delayMs);
      }
    }),
    (error) => isProviderRegisterSqliteBusyError(error)
  );

  assert.equal(fetchCalls, SQLITE_BUSY_MAX_ATTEMPTS);
  assert.deepEqual(
    delays,
    Array.from(
      { length: SQLITE_BUSY_MAX_ATTEMPTS - 1 },
      (_, index) => providerRegisterRetryDelayMs(index + 1)
    )
  );
});

test("provider-register defers persistent SQLite busy and applies the key in background", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "provider-register-background-"));
  const homeRoot = path.join(tempRoot, "home");
  const app = {
    getPath(name) {
      if (name === "home") {
        return homeRoot;
      }
      return path.join(tempRoot, name);
    }
  };
  const registerPath = resolveProviderRegisterPath(app, "linux");
  const runtimeRoot = path.dirname(registerPath);
  const providersRoot = path.join(runtimeRoot, "registries", "providers");
  const providerPath = path.join(providersRoot, "th-deepseek.yml");
  let fetchCalls = 0;

  fs.mkdirSync(providersRoot, { recursive: true });
  fs.writeFileSync(
    providerPath,
    "key: th-deepseek\nbaseUrl: https://transit-hub.example\napiKey: null\n",
    "utf8"
  );
  fs.writeFileSync(
    registerPath,
    `${JSON.stringify({
      version: 1,
      enabled: true,
      endpoint: "https://transit-hub.example/api/apply-apikey",
      grant: { type: "jwt", token: "test-jwt" },
      providers: ["th-deepseek"]
    }, null, 2)}\n`,
    "utf8"
  );

  try {
    const result = await ensureProviderRegisterApiKey(app, {
      platform: "linux",
      deviceId: "desktop-device",
      deferSqliteBusy: true,
      backgroundRetryBaseDelayMs: 0,
      fetchImpl: async () => {
        fetchCalls += 1;
        if (fetchCalls <= SQLITE_BUSY_MAX_ATTEMPTS) {
          return response(500, '{"error":"database is locked (5) (SQLITE_BUSY)"}');
        }
        return response(200, '{"key":"dk_background_succeeded"}', "OK");
      },
      sleepImpl: async () => {}
    });

    assert.deepEqual(result, { status: "deferred", reason: "sqlite-busy" });

    const deadline = Date.now() + 1_000;
    while (fs.existsSync(registerPath) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    assert.equal(fetchCalls, SQLITE_BUSY_MAX_ATTEMPTS + 1);
    assert.equal(fs.existsSync(registerPath), false);
    assert.match(fs.readFileSync(providerPath, "utf8"), /^apiKey: dk_background_succeeded$/m);
  } finally {
    clearProviderRegisterBackgroundRetries();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("provider-register recognizes only server-side SQLite lock responses as transient", () => {
  assert.equal(
    isTransientSqliteBusyResponse(500, '{"error":"database is locked (5) (SQLITE_BUSY)"}'),
    true
  );
  assert.equal(isTransientSqliteBusyResponse(503, "database table is locked"), true);
  assert.equal(isTransientSqliteBusyResponse(400, "database is locked (SQLITE_BUSY)"), false);
  assert.equal(isTransientSqliteBusyResponse(500, "permission denied"), false);
  assert.equal(providerRegisterBackgroundRetryDelayMs(1), 15_000);
  assert.equal(providerRegisterBackgroundRetryDelayMs(6), 300_000);
});
