import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const broker = require("../dist-electron/main/modules/agent-platform/realtime/realtime-broker.shared.js");
const bridge = require("../dist-electron/main/modules/agent-platform/ipc.shared.js");

test("query and attach errors retain the Platform envelope through the Broker and Frame Port", () => {
  for (const type of ["active_stream_exists", "provider_rate_limited", "new_platform_error"]) {
    const upstream = {
      frame: "error", id: "upstream-query", type, code: 409,
      msg: "detach the current run stream before starting or attaching another",
      data: { error: { code: type, category: "protocol", scope: "connection", retryable: false } },
    };
    const error = broker.frameError(upstream);
    const forwarded = bridge.frameError("guest-query", bridge.bridgeErrorCode(error), error.message, bridge.frameErrorOptions(error));
    assert.deepEqual(forwarded, { ...upstream, id: "guest-query" });
  }
});

test("host errors retain their own classification and metadata", () => {
  const error = broker.brokerError("capability_denied", "not authorized", { retryable: false });
  const frame = bridge.frameError("guest-query", bridge.bridgeErrorCode(error), error.message, bridge.frameErrorOptions(error));
  assert.equal(frame.type, "capability_denied");
  assert.equal(frame.status, 403);
  assert.equal(frame.data.error.retryable, false);
});
