import test from "node:test";
import assert from "node:assert/strict";

const {
  writeSafeConsoleError,
  __testInternals
} = await import("../dist-electron/main/safe-console.js");

test("writeSafeConsoleError suppresses console stream write failures", () => {
  assert.doesNotThrow(() => {
    writeSafeConsoleError(() => {
      const error = new Error("write EIO");
      error.code = "EIO";
      throw error;
    }, "webview failed to load");
  });
});

test("writeSafeConsoleError rethrows unexpected logger errors", () => {
  const error = new Error("format failed");
  assert.throws(() => {
    writeSafeConsoleError(() => {
      throw error;
    }, "webview failed to load");
  }, error);
});

test("isConsoleWriteFailure recognizes destroyed console streams", () => {
  assert.equal(__testInternals.isConsoleWriteFailure({ code: "ERR_STREAM_DESTROYED" }), true);
});
