import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { createMainNavigationSubscription } = require("../dist-electron/preload/main-navigation.js");

test("a cold Main navigation sent before React subscribes is delivered once", () => {
  const ipc = new EventEmitter();
  const subscribe = createMainNavigationSubscription(ipc);
  const route = "/agent/cutej?newChat=1791687879299";
  ipc.emit("app.navigate", {}, route);
  const received = [];
  const unsubscribe = subscribe(value => received.push(value));
  assert.deepEqual(received, [route]);
  unsubscribe();
  subscribe(value => received.push(value));
  assert.deepEqual(received, [route], "a consumed intent cannot replay on resubscription");
});

test("multiple cold opens keep the latest explicit Main route", () => {
  const ipc = new EventEmitter();
  const subscribe = createMainNavigationSubscription(ipc);
  ipc.emit("app.navigate", {}, "/agent/cutej?newChat=1791687879299");
  ipc.emit("app.navigate", {}, "/agent/cutej?newChat=1791687879300");
  ipc.emit("app.navigate", {}, { forged: true });
  const received = [];
  subscribe(value => received.push(value));
  assert.deepEqual(received, ["/agent/cutej?newChat=1791687879300"]);
});

test("live navigation and cleanup do not replay history or accumulate IPC listeners", () => {
  const ipc = new EventEmitter();
  const subscribe = createMainNavigationSubscription(ipc);
  const first = [], second = [];
  const unsubscribe = subscribe(value => first.push(value));
  ipc.emit("app.navigate", {}, "/agent/cutej?chatId=chat-a");
  unsubscribe();
  ipc.emit("app.navigate", {}, "/agent/cutej?chatId=chat-b");
  subscribe(value => second.push(value));
  ipc.emit("app.navigate", {}, "/settings");
  assert.deepEqual(first, ["/agent/cutej?chatId=chat-a"]);
  assert.deepEqual(second, ["/agent/cutej?chatId=chat-b", "/settings"]);
  assert.equal(ipc.listenerCount("app.navigate"), 1);
});
