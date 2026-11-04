import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const root = "../dist-electron/main/modules/services/";
const capabilities = require(`${root}manager/capabilities.js`);
const registry = require(`${root}service-registry.js`);
const states = require(`${root}manager/service-state.js`);
const policy = require(`${root}manager/verification-policy.js`);
const layout = require(`${root}manager/layout.js`);
const probes = require(`${root}manager/service-probes.js`);
const verification = require(`${root}manager/verification.js`);

for (const platform of ["darwin", "win32"]) {
  for (const scenario of ["success", "retry", "auth failure", "missing health", "persistent failure"]) {
    test(`${platform}: verification ${scenario} separates health from token preload`, async (t) => {
      const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
      Object.defineProperty(process, "platform", { value: platform });
      t.after(() => Object.defineProperty(process, "platform", descriptor));
      const requirements = [
        { phase: "verifyRunning", capability: "auth.accessToken", action: "preload" },
        { phase: "verifyRunning", service: "agent-platform", action: "waitHttp", target: "/healthz" }
      ];
      t.mock.method(registry, "getService", (id) => ({ id, name: id, desktop: { capabilities: { requires: requirements } } }));
      t.mock.method(layout, "getServiceLayout", () => ({}));
      t.mock.method(states, "getServiceState", async (_app, id) => ({ status: "running", healthMeta: { webUrl: `http://localhost/${id}` } }));
      t.mock.method(policy, "buildVerificationResult", () => ({ verified: true, actualStatus: "running", pidAlive: true, issues: [] }));
      t.mock.method(policy, "hasVerifyRunningRequirements", () => true);
      t.mock.method(policy, "getDependencyRunningVerificationTimeoutMs", () => ["persistent failure", "missing health"].includes(scenario) ? 0 : 30000);
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
      const targets = [];
      t.mock.method(probes, "probeHttpUrl", async () => ({ ok: true, statusCode: 200 }));
      t.mock.method(probes, "probeServiceHealth", async (target, options) => {
        assert.equal(options, undefined, "health checks must not pass credentials");
        targets.push(target);
        const statusCode = scenario === "persistent failure" ? 503
          : scenario === "retry" && issues === 1 ? 503
          : scenario === "missing health" ? 404 : 200;
        return { target, ok: statusCode === 200, statusCode, message: `HTTP ${statusCode}` };
      });
      const options = { integrationPorts: {} };
      const result = await verification.verifyServiceState({}, "agent-webclient", "running", options);
      const retried = ["retry", "auth failure", "persistent failure", "missing health"].includes(scenario);
      assert.equal(result.verified, !["persistent failure", "missing health"].includes(scenario));
      assert.equal(issues, retried ? 2 : 1);
      assert.equal(delays.mock.callCount(), retried ? 1 : 0);
      assert.equal(targets.length, retried ? 2 : 1);
      assert.ok(targets.every((target) => target === "http://localhost/healthz"));
      const logs = JSON.stringify(warnings.mock.calls.map((call) => call.arguments));
      assert.equal(logs.includes("secret-fixture"), false);
      if (scenario === "retry") assert.match(logs, /503/);
      if (scenario === "persistent failure") assert.match(logs, /503/);
      // Even with the same caller options, a later verification gets a fresh result.
      const previousIssues = issues;
      await verification.collectServiceVerification({}, "agent-webclient", "running", options);
      assert.equal(issues, previousIssues + 1);
    });
  }
}

const requirements = require(`${root}manager/capability-requirements.js`);
const processCleanup = require(`${root}manager/process-cleanup.js`);
const managedCleanup = require(`${root}manager/managed-cleanup.js`);
const processIdentity = require(`${root}manager/process-identity.js`);
const hostPolicy = require(`${root}manager/host-policy.js`);

for (const platform of ["darwin", "win32"]) {
  for (const id of ["agent-platform", "agent-container-hub"]) {
    test(`${platform}: ${id} requires its own health result`, (t) => {
      const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
      Object.defineProperty(process, "platform", { value: platform });
      t.after(() => Object.defineProperty(process, "platform", descriptor));
      t.mock.method(processCleanup, "isProcessRunning", () => true);
      t.mock.method(managedCleanup, "listListeningPids", () => [123]);
      t.mock.method(processIdentity, "pidMatchesInstallDir", () => true);
      t.mock.method(hostPolicy, "isHostManagedService", () => false);
      const service = { id };
      const state = { status: "running", installDir: "/fixture", healthMeta: { pid: 123, port: 17000, webUrl: "http://localhost:17000/" } };
      const target = requirements.getDefaultRequirementHttpTarget(service, state.healthMeta.webUrl);
      assert.equal(target, "http://localhost:17000/healthz");
      assert.equal(policy.buildVerificationResult(service, state, "running", []).verified, false);
      assert.equal(policy.buildVerificationResult(service, state, "running", [{ target, ok: false, statusCode: 503 }]).verified, false);
      assert.equal(policy.buildVerificationResult(service, state, "running", [{ target, ok: true, statusCode: 200 }]).verified, true);
      assert.equal(policy.buildVerificationResult(service, state, "running", [{ target: target + "-other", ok: true }]).verified, false);
      if (id === "agent-container-hub") {
        t.mock.method(processIdentity, "pidMatchesInstallDir", () => false);
        assert.equal(policy.buildVerificationResult(service, state, "running", [{ target, ok: true }], { skipManagedPortProbe: true }).verified, false);
      }
    });
  }
}

test("health probe rejects redirects, non-JSON and failures without sending credentials", async (t) => {
  const { EventEmitter } = require("node:events");
  const http = require("node:http");
  let scenario;
  t.mock.method(http, "request", (_url, options, callback) => {
    assert.equal(options.headers, undefined);
    assert.ok(options.timeout > 3000, "allow the Platform sidecar probe to complete");
    const request = new EventEmitter();
    request.end = () => {
      const response = new EventEmitter();
      response.statusCode = scenario.status;
      response.headers = { "content-type": scenario.type };
      callback(response);
      response.emit("data", Buffer.from(scenario.body));
      response.emit("end");
    };
    return request;
  });
  for (scenario of [
    { status: 200, type: "application/json", body: '{"status":"ok"}', ok: true },
    { status: 200, type: "text/html", body: "<html>login</html>", ok: false },
    { status: 302, type: "application/json", body: "{}", ok: false },
    { status: 401, type: "application/json", body: "{}", ok: false },
    { status: 404, type: "application/json", body: "{}", ok: false },
    { status: 503, type: "application/json", body: "{}", ok: false }
  ]) {
    assert.equal((await probes.probeServiceHealth("http://localhost/healthz")).ok, scenario.ok);
  }
});
