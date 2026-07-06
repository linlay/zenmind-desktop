import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const {
  PAGE_TO_PRELOAD_EVENT,
  PRELOAD_TO_PAGE_EVENT,
  DESKTOP_WEBVIEW_BRIDGE_FLAG,
  buildServiceWebviewMainWorldScript
} = require("../dist-electron/preload/service-webview-main-world.js");
const {
  AGENT_APP_CLIPBOARD_REQUEST_TYPE,
  SERVICE_WEBVIEW_BRIDGE_ROUTE_CHANNEL
} = require("../dist-electron/shared/service-webview-bridge.js");
const {
  AGENT_AUTH_REQUEST_TYPE,
  AGENT_AUTH_RESPONSE_TYPE
} = require("../dist-electron/shared/auth-bridge.js");

function removedBridgeFlagName() {
  return `__${["ZENMIND", "DESKTOP", "WEBVIEW", "BRIDGE"].join("_")}__`;
}

function removedProtocol(...parts) {
  return parts.join(":");
}

function createStorage() {
  const values = new Map();
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    removeItem(key) {
      values.delete(key);
    },
    setItem(key, value) {
      values.set(key, String(value));
    }
  };
}

function createEventTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, listener) {
      const bucket = listeners.get(type) ?? new Set();
      bucket.add(listener);
      listeners.set(type, bucket);
    },
    dispatchEvent(event) {
      const bucket = listeners.get(event.type) ?? new Set();
      for (const listener of Array.from(bucket)) {
        listener(event);
      }
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    listenerCount(type) {
      return listeners.get(type)?.size ?? 0;
    }
  };
}

function createFakeWindow(options = {}) {
  const originalPostMessageCalls = [];
  const eventTarget = createEventTarget();
  function OriginalWebSocket(url, protocols) {
    this.url = url;
    this.protocols = protocols;
  }
  OriginalWebSocket.CONNECTING = 0;
  OriginalWebSocket.OPEN = 1;
  OriginalWebSocket.CLOSING = 2;
  OriginalWebSocket.CLOSED = 3;

  const window = {
    WebSocket: OriginalWebSocket,
    location: {
      href: "http://example.test/app?wsSource=desktop-chat",
      origin: "http://example.test",
      search: "?wsSource=desktop-chat"
    },
    postMessage(value, targetOrigin, transfer) {
      originalPostMessageCalls.push({
        receiver: this,
        targetOrigin,
        transfer,
        value
      });
      eventTarget.dispatchEvent({
        data: value,
        origin: this.location?.origin ?? "",
        source: this,
        type: "message"
      });
    },
    sessionStorage: createStorage(),
    addEventListener: eventTarget.addEventListener,
    dispatchEvent: eventTarget.dispatchEvent,
    removeEventListener: eventTarget.removeEventListener
  };

  window.parent = options.parent ?? window;

  return {
    originalPostMessageCalls,
    window
  };
}

function runMainWorldScript(window) {
  class CustomEvent {
    constructor(type, init = {}) {
      this.type = type;
      this.detail = init.detail;
    }
  }
  class MessageEvent {
    constructor(type, init = {}) {
      this.type = type;
      this.data = init.data;
      this.origin = init.origin;
      this.source = init.source;
    }
  }

  const context = vm.createContext({
    CustomEvent,
    MessageEvent,
    URL,
    URLSearchParams,
    clearInterval,
    clearTimeout,
    console,
    location: window.location,
    setInterval,
    setTimeout,
    window
  });

  vm.runInContext(buildServiceWebviewMainWorldScript(), context);
}

test("service webview main-world script does not overwrite parent postMessage", () => {
  const parent = {
    postMessage() {}
  };
  const originalParentPostMessage = parent.postMessage;
  const { window } = createFakeWindow({ parent });

  runMainWorldScript(window);

  assert.equal(window.parent.postMessage, originalParentPostMessage);
});

test("service webview main-world script does not overwrite window postMessage", () => {
  const { window } = createFakeWindow();
  const originalWindowPostMessage = window.postMessage;

  runMainWorldScript(window);

  assert.equal(window.postMessage, originalWindowPostMessage);
  assert.equal(window[DESKTOP_WEBVIEW_BRIDGE_FLAG], true);
  assert.equal(window[removedBridgeFlagName()], undefined);
});

test("service webview main-world script forwards ordinary postMessage calls", () => {
  const { originalPostMessageCalls, window } = createFakeWindow();
  const captured = [];
  const payload = { type: "ordinary-message" };

  runMainWorldScript(window);
  window.addEventListener(PAGE_TO_PRELOAD_EVENT, (event) => {
    captured.push(event.detail);
  });
  window.postMessage(payload, "*");

  assert.equal(originalPostMessageCalls.length, 1);
  assert.equal(originalPostMessageCalls[0].receiver, window);
  assert.equal(originalPostMessageCalls[0].targetOrigin, "*");
  assert.equal(originalPostMessageCalls[0].value, payload);
  assert.deepEqual(captured, []);
});

test("service webview main-world script dispatches desktop bridge requests from native message events", () => {
  const { originalPostMessageCalls, window } = createFakeWindow();
  const captured = [];
  const payload = {
    type: AGENT_APP_CLIPBOARD_REQUEST_TYPE,
    requestId: "request-1",
    text: "hello"
  };

  runMainWorldScript(window);
  window.addEventListener(PAGE_TO_PRELOAD_EVENT, (event) => {
    captured.push(event.detail);
  });
  window.postMessage(payload, "*");

  assert.equal(originalPostMessageCalls.length, 1);
  assert.equal(originalPostMessageCalls[0].value, payload);
  assert.deepEqual(captured, [payload]);
});

test("service webview main-world script ignores removed legacy bridge requests", () => {
  const { window } = createFakeWindow();
  const captured = [];
  const payloads = [
    {
      type: removedProtocol("zenmind", "agent-app-clipboard", "request"),
      requestId: "clipboard-legacy-1",
      text: "hello"
    },
    {
      type: removedProtocol("zenmind", "desktop-screenshot", "capture"),
      requestId: "screenshot-legacy-1"
    },
    {
      type: removedProtocol("zenmind", "agent-app-auth", "request"),
      requestId: "auth-legacy-1",
      action: "getAccessToken"
    },
    {
      type: removedProtocol("desktop", "agent-app-auth", "request"),
      requestId: "auth-legacy-2",
      action: "getAccessToken"
    }
  ];

  runMainWorldScript(window);
  window.addEventListener(PAGE_TO_PRELOAD_EVENT, (event) => {
    captured.push(event.detail);
  });
  for (const payload of payloads) {
    window.postMessage(payload, "*");
  }

  assert.deepEqual(captured, []);
});

test("service webview main-world script dispatches auth bridge requests", () => {
  const { window } = createFakeWindow();
  const captured = [];
  const payload = {
    type: AGENT_AUTH_REQUEST_TYPE,
    requestId: "auth-1",
    action: "getAccessToken",
    reason: "missing"
  };

  runMainWorldScript(window);
  window.addEventListener(PAGE_TO_PRELOAD_EVENT, (event) => {
    captured.push(event.detail);
  });
  window.postMessage(payload, "*");

  assert.deepEqual(captured, [payload]);
});

test("service webview main-world script seeds tokens from auth responses", () => {
  const { window } = createFakeWindow();

  runMainWorldScript(window);
  window.dispatchEvent({
    type: PRELOAD_TO_PAGE_EVENT,
    detail: {
      type: AGENT_AUTH_RESPONSE_TYPE,
      requestId: "auth-1",
      token: "token-1"
    }
  });

  assert.equal(window.sessionStorage.getItem("agent-webclient.appAccessToken"), "token-1");
  assert.equal(window.__AGENT_APP_ACCESS_TOKEN, "token-1");
});

test("service webview main-world script ignores removed legacy auth responses", () => {
  const { window } = createFakeWindow();
  const received = [];

  runMainWorldScript(window);
  window.addEventListener("message", (event) => {
    received.push(event.data);
  });
  window.dispatchEvent({
    type: PRELOAD_TO_PAGE_EVENT,
    detail: {
      type: removedProtocol("zenmind", "agent-app-auth", "response"),
      requestId: "auth-legacy-1",
      token: "token-legacy"
    }
  });

  assert.equal(window.sessionStorage.getItem("agent-webclient.appAccessToken"), null);
  assert.equal(window.__AGENT_APP_ACCESS_TOKEN, undefined);
  assert.deepEqual(received, []);
});

test("service webview main-world script emits route changes on current channel", () => {
  const { window } = createFakeWindow();
  const currentChannelPayloads = [];
  const payload = {
    type: "desktopRouteChanged",
    pathname: "/registries",
    search: "?hostTheme=light"
  };

  runMainWorldScript(window);
  window.electronAPI.onFromMain(SERVICE_WEBVIEW_BRIDGE_ROUTE_CHANNEL, (_event, nextPayload) => {
    currentChannelPayloads.push(nextPayload);
  });

  window.dispatchEvent({
    type: PRELOAD_TO_PAGE_EVENT,
    detail: payload
  });

  assert.deepEqual(currentChannelPayloads, [payload]);
});
