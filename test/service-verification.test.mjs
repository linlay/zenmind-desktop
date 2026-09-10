import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const root = "../dist-electron/main/modules/services/";
const capabilities = require(`${root}manager/capabilities.js`);
const registry = require(`${root}service-registry.js`);
const states = require(`${root}manager/index.part-2.js`);
const layout = require(`${root}manager/layout.js`);
const probes = require(`${root}manager/service-probes.js`);
const verification = require(`${root}manager/index.part-4.part-2.js`);

for (const platform of ["darwin", "win32"]) {
  for (const scenario of ["success", "retry", "auth failure", "fallback", "persistent failure"]) {
    test(`${platform}: verification ${scenario} shares one token per round`, async (t) => {
      const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
      Object.defineProperty(process, "platform", { value: platform });
      t.after(() => Object.defineProperty(process, "platform", descriptor));
      const requirements = [
        { phase: "verifyRunning", capability: "auth.accessToken", action: "preload" },
        { phase: "verifyRunning", service: "agent-platform", action: "waitHttp", target: "/api/runtime-info", authCapability: "auth.accessToken" }
      ];
      t.mock.method(registry, "getService", (id) => ({ id, name: id, desktop: { capabilities: { requires: requirements } } }));
      t.mock.method(layout, "getServiceLayout", () => ({}));
      t.mock.method(states, "getServiceState", async (_app, id) => ({ status: "running", healthMeta: { webUrl: `http://localhost/${id}` } }));
      t.mock.method(states, "buildVerificationResult", () => ({ verified: true, actualStatus: "running", pidAlive: true, issues: [] }));
      t.mock.method(states, "hasVerifyRunningRequirements", () => true);
      t.mock.method(states, "getDependencyRunningVerificationTimeoutMs", () => scenario === "persistent failure" ? 0 : 30000);
      // A positive delay must not cause a second round after success.
      t.mock.method(probes, "getServiceVerificationDelayMs", () => 1500);
      const delays = t.mock.method(probes, "delay", async () => {});
      const warnings = t.mock.method(console, "warn", () => {});
      let issues = 0;
      const factory = capabilities.createVerificationCapabilityResolver;
      t.mock.method(capabilities, "createVerificationCapabilityResolver", () => factory(async () => {
        issues++;
        if (scenario === "auth failure" && issues === 1) throw new Error("fixture authentication unavailable");
        return { token: `secret-fixture-${issues}` };
      }));
      const authHeaders = [];
      t.mock.method(probes, "probeHttpUrl", async (target, options) => {
        if (!options?.headers) return { ok: true, statusCode: 200 };
        authHeaders.push(options.headers.Authorization);
        const statusCode = scenario === "persistent failure" ? 503
          : scenario === "retry" && issues === 1 ? 401
          : scenario === "fallback" && target.endsWith("/api/runtime-info") ? 404 : 200;
        return { ok: statusCode === 200, statusCode, message: `HTTP ${statusCode}` };
      });
      const options = { integrationPorts: {} };
      const result = await verification.verifyServiceState({}, "agent-webclient", "running", options);
      const retried = ["retry", "auth failure", "persistent failure"].includes(scenario);
      assert.equal(result.verified, scenario !== "persistent failure");
      assert.equal(issues, retried ? 2 : 1);
      assert.equal(delays.mock.callCount(), retried ? 1 : 0);
      assert.deepEqual(authHeaders, scenario === "fallback"
        ? ["Bearer secret-fixture-1", "Bearer secret-fixture-1"]
        : scenario === "auth failure" ? ["Bearer secret-fixture-2"]
        : retried ? ["Bearer secret-fixture-1", "Bearer secret-fixture-2"] : ["Bearer secret-fixture-1"]);
      const logs = JSON.stringify(warnings.mock.calls.map((call) => call.arguments));
      assert.equal(logs.includes("secret-fixture"), false);
      if (scenario === "retry") assert.match(logs, /401/);
      if (scenario === "persistent failure") assert.match(logs, /503/);
      // Even with the same caller options, a later verification gets a fresh result.
      const previousIssues = issues;
      await verification.collectServiceVerification({}, "agent-webclient", "running", options);
      assert.equal(issues, previousIssues + 1);
    });
  }
}
