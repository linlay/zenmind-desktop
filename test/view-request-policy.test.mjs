import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { allowsViewRequest } = require("../dist-electron/main/modules/agent-platform/frame-port/view-request-policy.js");
const base = { identityKey: 'view:["chat","run","content","0"]', ownerChatId: "chat",
  guestUrl: "http://localhost:8130/view-viewer/content?chatId=chat&runId=run&viewIndex=0" };

test("View data and declared operations stay scoped to the registered Chat/Run", () => {
  for (const type of ["/api/chat", "/api/view", "/api/view/query", "/api/view/invoke"]) {
    assert.equal(allowsViewRequest({ ...base, type, payload: { chatId: "chat", runId: "run" } }), true);
    assert.equal(allowsViewRequest({ ...base, type, payload: { chatId: "other", runId: "run" } }), false);
  }
  for (const type of ["/api/query", "/api/attach", "/api/btw", "/api/interrupt", "/api/connectors"]) {
    assert.equal(allowsViewRequest({ ...base, type, payload: { chatId: "chat", runId: "run" } }), false);
  }
  assert.equal(allowsViewRequest({ ...base, type: "/api/view/invoke", payload: { chatId: "chat", runId: "other" } }), false);
  assert.equal(allowsViewRequest({ ...base, type: "/api/view", payload: { chatId: "chat", usage: "form" } }), false);
});

test("Navigation, duplicate identity parameters, and malformed registration fail closed", () => {
  for (const override of [
    { identityKey: "view:broken" }, { ownerChatId: "other" },
    { guestUrl: base.guestUrl.replace("/content?", "/other?") },
    { guestUrl: base.guestUrl + "&chatId=chat" },
    { guestUrl: base.guestUrl.replace("runId=run", "runId=other") },
  ]) assert.equal(allowsViewRequest({ ...base, ...override, type: "/api/chat", payload: { chatId: "chat" } }), false);
});
