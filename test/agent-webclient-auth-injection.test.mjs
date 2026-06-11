import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const {
  buildAgentWebclientAccessTokenInjectionScript
} = require("../dist-electron/shared/agent-webclient-auth-injection.js");

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
    listenerCount(type) {
      return listeners.get(type)?.size ?? 0;
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    }
  };
}

function createFakeWindow() {
  const postMessageCalls = [];
  const eventTarget = createEventTarget();
  const window = {
    location: {
      origin: "http://example.test"
    },
    postMessage(value, targetOrigin, transfer) {
      postMessageCalls.push({
        targetOrigin,
        transfer,
        value
      });
      eventTarget.dispatchEvent({
        data: value,
        origin: window.location.origin,
        source: window,
        type: "message"
      });
    },
    sessionStorage: createStorage(),
    addEventListener: eventTarget.addEventListener,
    dispatchEvent: eventTarget.dispatchEvent,
    removeEventListener: eventTarget.removeEventListener
  };

  return {
    listenerCount: eventTarget.listenerCount,
    postMessageCalls,
    window
  };
}

function runInjectionScript(window, token, desktopAuthContext = "desktop-auth-1") {
  class MessageEvent {
    constructor(type, init = {}) {
      this.type = type;
      this.data = init.data;
      this.origin = init.origin;
      this.source = init.source;
    }
  }

  const context = vm.createContext({
    MessageEvent,
    location: window.location,
    window
  });

  return vm.runInContext(
    buildAgentWebclientAccessTokenInjectionScript(token, desktopAuthContext),
    context
  );
}

function toPlainJson(value) {
  return JSON.parse(JSON.stringify(value));
}

test("agent-webclient token fallback does not overwrite window postMessage", () => {
  const { listenerCount, window } = createFakeWindow();
  const originalPostMessage = window.postMessage;

  const result = runInjectionScript(window, "token-one");

  assert.equal(window.postMessage, originalPostMessage);
  assert.equal(window.__ZENMIND_DESKTOP_WEBVIEW_BRIDGE__, true);
  assert.equal(window.__AGENT_APP_ACCESS_TOKEN, "token-one");
  assert.equal(window.sessionStorage.getItem("agent-webclient.appAccessToken"), "token-one");
  assert.equal(window.sessionStorage.getItem("agent-webclient.appAuthContext"), "desktop-auth-1");
  assert.equal(listenerCount("message"), 1);
  assert.deepEqual(toPlainJson(result), {
    bridge: true,
    tokenBeforeLength: 0,
    tokenAfterLength: "token-one".length
  });
});

test("agent-webclient token fallback responds through message listener and updates repeated injections", () => {
  const { listenerCount, window } = createFakeWindow();
  const responses = [];

  runInjectionScript(window, "token-one");
  runInjectionScript(window, "token-two");
  window.addEventListener("message", (event) => {
    if (event.data?.type === "zenmind:agent-app-auth:response") {
      responses.push(event.data);
    }
  });

  window.dispatchEvent({
    data: {
      type: "zenmind:agent-app-auth:request",
      requestId: "request-1",
      action: "getAccessToken"
    },
    origin: window.location.origin,
    source: window,
    type: "message"
  });

  assert.equal(window.postMessage.name, "postMessage");
  assert.equal(window.__AGENT_APP_ACCESS_TOKEN, "token-two");
  assert.equal(window.sessionStorage.getItem("agent-webclient.appAccessToken"), "token-two");
  assert.equal(listenerCount("message"), 2);
  assert.deepEqual(toPlainJson(responses), [
    {
      type: "zenmind:agent-app-auth:response",
      requestId: "request-1",
      token: "token-two"
    }
  ]);
});
