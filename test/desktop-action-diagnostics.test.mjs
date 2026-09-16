import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { normalizeActionDiagnostics, sanitizeActionErrorText } = require("../dist-electron/main/modules/desktop-actions/diagnostics.js");
const { desktopActionErrorStatus } = require("../dist-electron/shared/desktop-action-diagnostics.js");

test("Action diagnostics preserve causes and recovery with bounded secret-free details", () => {
  const result = normalizeActionDiagnostics("tooling_worker_failed", {
    stage: "internal", executionState: "unknown",
    cause: { code: "MODULE_NOT_FOUND", message: "missing /Users/example/worker.js password=private-value" },
    recovery: { strategy: "repair_host", message: "Rebuild Main and Worker together." },
    context: { token: "private-value", windows: "C:\\Users\\example\\worker.js", huge: "x".repeat(30000) }
  });
  assert.equal(result.context.windows, "C:\\Users\\example\\worker.js");
  assert.equal(result.cause.message, "missing /Users/example/worker.js password=[REDACTED]");
  assert.equal(result.category, "internal");
  assert.equal(result.cause.code, "MODULE_NOT_FOUND");
  assert.equal(result.recovery.strategy, "repair_host");
  assert.equal(result.executionState, "unknown");
  assert.ok(result.diagnosticId);
  assert.ok(JSON.stringify(result).length < 16000);
  assert.doesNotMatch(JSON.stringify(result), /private-value/);
  assert.equal(desktopActionErrorStatus(result.category), 500);
});

test("validation and timeout remain distinct and never assume mutation rollback", () => {
  const invalid = normalizeActionDiagnostics("invalid_args", { executionState: "not_started", issues: [{ path: "args.projectPath", code: "required" }] });
  assert.equal(invalid.category, "validation");
  assert.equal(invalid.stage, "arguments");
  assert.equal(invalid.recovery.strategy, "fix_input");
  assert.equal(desktopActionErrorStatus(invalid.category), 400);
  const timeout = normalizeActionDiagnostics("renderer_timeout", {});
  assert.equal(timeout.executionState, "unknown");
  assert.equal(desktopActionErrorStatus(timeout.category), 504);
  assert.equal(sanitizeActionErrorText("Authorization: Bearer abc123"), "Authorization: [REDACTED]");
});

 test("diagnostics preserve root paths, versions and stack text", () => {
  for (const message of [
    "ENOENT: no such file or directory, mkdir '/personal-workbench/distribution'",
    "missing /Users/example/a b/worker.js; version 5.5.0; filename webapp-tooling-worker.js",
    String.raw`ENOENT C:\Users\example\distribution and \\server\share\distribution`,
  ]) assert.equal(sanitizeActionErrorText(message), message);
  const stack = "Error: ENOENT\n    at /Users/example/worker.js:12:3";
  const result = normalizeActionDiagnostics("file_unavailable", { context: { workspaceRoot: "/", stack, passwordPolicy: "required" } });
  assert.equal(result.context.workspaceRoot, "/");
  assert.equal(result.context.stack, stack);
});

test("password redaction leaves surrounding error context intact", () => {
  assert.equal(sanitizeActionErrorText('connect failed {"password": "two words", "path": "/Users/example/db"}'), 'connect failed {"password": "[REDACTED]", "path": "/Users/example/db"}');
  assert.equal(sanitizeActionErrorText("connect postgres://alice:p%40ss@localhost:5432/db?version=5.5.0"), "connect postgres://alice:[REDACTED]@localhost:5432/db?version=5.5.0");
});

 test("credential matching preserves metadata and surrounding URL and JSON fields", () => {
  const metadata = { tokenCount: 42, passwordPolicy: "required", secretName: "client-secret", cookiePath: "/Users/example/cookies", authorizationStatus: "denied" };
  assert.deepEqual(normalizeActionDiagnostics("file_unavailable", { context: metadata }).context, metadata);
  for (const key of ["password", "accessToken", "refresh_token", "Cookie", "api_key", "clientSecret"]) {
    assert.equal(normalizeActionDiagnostics("file_unavailable", { context: { [key]: "example-credential" } }).context[key], "[REDACTED]");
  }
  for (const [input, expected] of [
    ['{"accessToken": "example-credential", "path": "/Users/example/file"}', '{"accessToken": "[REDACTED]", "path": "/Users/example/file"}'],
    ["https://example.test/error?token=example-credential&path=/tmp/build&version=5.5.0", "https://example.test/error?token=[REDACTED]&path=/tmp/build&version=5.5.0"],
    ["Authorization: Bearer example-credential", "Authorization: [REDACTED]"],
    ["tokenCount=42 passwordPolicy=required", "tokenCount=42 passwordPolicy=required"],
  ]) assert.equal(sanitizeActionErrorText(input), expected);
});
