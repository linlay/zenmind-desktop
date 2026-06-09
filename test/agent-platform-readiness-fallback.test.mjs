import assert from "node:assert/strict";
import test from "node:test";
import { __testInternals } from "../dist-electron/main/services/manager/index.js";

test("agent-platform runtime-info readiness falls back to authenticated agent list on 404", () => {
  const fallback = __testInternals.resolveAgentPlatformReadinessFallbackTarget(
    "agent-platform",
    "http://127.0.0.1:7078/api/runtime-info",
    { ok: false, statusCode: 404, target: "http://127.0.0.1:7078/api/runtime-info" }
  );

  assert.equal(fallback, "http://127.0.0.1:7078/api/agents");
});

test("agent-platform runtime-info readiness fallback is limited to the missing runtime-info route", () => {
  assert.equal(
    __testInternals.resolveAgentPlatformReadinessFallbackTarget(
      "agent-platform",
      "http://127.0.0.1:7078/api/runtime-info",
      { ok: false, statusCode: 401, target: "http://127.0.0.1:7078/api/runtime-info" }
    ),
    null
  );
  assert.equal(
    __testInternals.resolveAgentPlatformReadinessFallbackTarget(
      "agent-container-hub",
      "http://127.0.0.1:7079/api/runtime-info",
      { ok: false, statusCode: 404, target: "http://127.0.0.1:7079/api/runtime-info" }
    ),
    null
  );
});
