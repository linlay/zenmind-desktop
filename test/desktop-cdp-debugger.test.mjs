import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const {
  EmbeddedCdpGateway,
  __testInternals: gatewayInternals
} = require("../dist-electron/main/embedded-cdp-gateway.js");
const {
  DESKTOP_CDP_TARGET_TIMEOUT_CODE,
  sendDesktopCdpCommand,
  isDesktopCdpTimeoutError
} = require("../dist-electron/main/desktop-cdp-debugger.js");

function createLoggerSink() {
  const events = [];
  return {
    events,
    logger: {
      debug: (...args) => events.push({ level: "debug", args }),
      warn: (...args) => events.push({ level: "warn", args })
    }
  };
}

async function captureRejection(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("expected promise to reject");
}

function createHangingDebugger() {
  let attached = false;
  return {
    get attached() {
      return attached;
    },
    debuggerRef: {
      isAttached: () => attached,
      attach: () => {
        attached = true;
      },
      detach: () => {
        attached = false;
      },
      sendCommand: () => new Promise(() => {})
    }
  };
}

test("desktop cdp helper times out with sanitized debug details", async () => {
  const { logger, events } = createLoggerSink();
  const { debuggerRef } = createHangingDebugger();

  const error = await captureRejection(sendDesktopCdpCommand(debuggerRef, "Runtime.evaluate", {
    expression: "window.__super_secret_script_value",
    returnByValue: true
  }, {
    targetId: "desktop-target",
    surfaceId: "website:target",
    webContentsId: 99,
    url: "https://example.test/path?token=super-secret#hash",
    title: "Example Page",
    timeoutMs: 15,
    logger
  }));

  assert.equal(isDesktopCdpTimeoutError(error), true);
  assert.equal(error.code, DESKTOP_CDP_TARGET_TIMEOUT_CODE);
  assert.equal(error.details.method, "Runtime.evaluate");
  assert.equal(error.details.targetId, "desktop-target");
  assert.equal(error.details.surfaceId, "website:target");
  assert.equal(error.details.webContentsId, 99);
  assert.equal(error.details.url, "https://example.test/path");
  assert.deepEqual(error.details.paramKeys, ["expression", "returnByValue"]);
  assert.equal(typeof error.details.timeoutMs, "number");
  assert.equal(events.some((event) => event.level === "debug" && event.args[0] === "[desktop-cdp] start"), true);
  assert.equal(events.some((event) => event.level === "warn" && event.args[0] === "[desktop-cdp] timeout"), true);
  const loggedText = JSON.stringify(events);
  assert.doesNotMatch(loggedText, /super_secret_script_value/u);
  assert.doesNotMatch(loggedText, /super-secret/u);
});

test("embedded cdp gateway command execution times out instead of hanging", async () => {
  const { logger } = createLoggerSink();
  const hanging = createHangingDebugger();
  const surface = {
    id: "website:slow",
    label: "Slow Page",
    url: "https://example.test/slow?token=secret",
    active: true
  };
  const contents = {
    id: 42,
    debugger: hanging.debuggerRef,
    isDestroyed: () => false,
    getURL: () => "https://example.test/live?token=secret#hash",
    getTitle: () => "Live Slow Page"
  };
  const gateway = new EmbeddedCdpGateway({
    getSurfaces: () => [surface],
    resolveWebContents: () => contents,
    commandTimeoutMs: 15,
    logger
  });

  const error = await captureRejection(gateway.executeCommand({
    method: "Runtime.evaluate",
    params: {
      expression: "window.__secret_should_not_log",
      returnByValue: true
    },
    targetId: gatewayInternals.stableTargetId(surface)
  }));

  assert.equal(isDesktopCdpTimeoutError(error), true);
  assert.equal(error.code, DESKTOP_CDP_TARGET_TIMEOUT_CODE);
  assert.equal(error.details.surfaceId, "website:slow");
  assert.equal(error.details.webContentsId, 42);
  assert.equal(error.details.url, "https://example.test/live");
  assert.deepEqual(error.details.paramKeys, ["expression", "returnByValue"]);
  assert.equal(hanging.attached, false);
});

test("current page cdp executor uses the shared command timeout helper", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "src", "main", "current-page-cdp-executor.ts"), "utf8");

  assert.match(source, /sendDesktopCdpCommand/u);
  assert.match(source, /isDesktopCdpTimeoutError/u);
  assert.match(source, /DESKTOP_CDP_TARGET_TIMEOUT_CODE/u);
});
