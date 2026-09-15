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
  assert.equal(result.category, "internal");
  assert.equal(result.cause.code, "MODULE_NOT_FOUND");
  assert.equal(result.recovery.strategy, "repair_host");
  assert.equal(result.executionState, "unknown");
  assert.ok(result.diagnosticId);
  assert.ok(JSON.stringify(result).length < 16000);
  assert.doesNotMatch(JSON.stringify(result), /private-value|example/);
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
  assert.equal(sanitizeActionErrorText("Authorization: Bearer abc123"), "Authorization: [REDACTED] [REDACTED]");
});
