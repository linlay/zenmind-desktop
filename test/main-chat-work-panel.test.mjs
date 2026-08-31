import test from "node:test";
import assert from "node:assert/strict";

import {
  resolvePendingMainChatWorkPanelOpen,
  shouldCancelPendingMainChatWorkPanelOpenForRoute,
} from "../dist-electron/shared/main-chat-work-panel.js";

const pending = {
  chatId: "chat-b",
  agentKey: "agent-1",
  routeKey: "/agent/agent-1?chatId=chat-b",
  minimumRevision: 4,
  registrationId: "registration-1",
  webContentsId: 101,
};

const committed = {
  registrationId: "registration-1",
  webContentsId: 101,
  revision: 5,
  identity: { kind: "canonical", agentKey: "agent-1", chatId: "chat-b" },
};

test("pending WorkPanel intent completes only at or after its captured Main Chat revision", () => {
  assert.equal(
    resolvePendingMainChatWorkPanelOpen(pending, committed, pending.routeKey),
    "complete",
  );
  assert.equal(
    resolvePendingMainChatWorkPanelOpen(
      pending,
      { ...committed, revision: pending.minimumRevision },
      pending.routeKey,
    ),
    "complete",
  );
  assert.equal(
    resolvePendingMainChatWorkPanelOpen(
      pending,
      { ...committed, revision: pending.minimumRevision - 1 },
      pending.routeKey,
    ),
    "wait",
  );
  assert.equal(
    resolvePendingMainChatWorkPanelOpen(
      pending,
      {
        ...committed,
        identity: { kind: "canonical", agentKey: "agent-1", chatId: "chat-c" },
      },
      pending.routeKey,
    ),
    "wait",
  );
  assert.equal(
    resolvePendingMainChatWorkPanelOpen(pending, committed, "/agent/agent-1?chatId=chat-c"),
    "wait",
  );
});

test("pending WorkPanel intent is cancelled when the Main Chat guest generation changes", () => {
  assert.equal(
    resolvePendingMainChatWorkPanelOpen(
      pending,
      { ...committed, registrationId: "registration-2" },
      pending.routeKey,
    ),
    "cancel",
  );
  assert.equal(
    resolvePendingMainChatWorkPanelOpen(
      pending,
      { ...committed, webContentsId: 202 },
      pending.routeKey,
    ),
    "cancel",
  );
});

test("pending WorkPanel intent is cancelled when the user leaves its desired route", () => {
  assert.equal(
    shouldCancelPendingMainChatWorkPanelOpenForRoute(pending, pending.routeKey),
    false,
  );
  assert.equal(
    shouldCancelPendingMainChatWorkPanelOpenForRoute(
      pending,
      "/agent/agent-1?chatId=chat-c",
    ),
    true,
  );
});

test("first Main Chat commit may satisfy an intent without a previous guest identity", () => {
  assert.equal(
    resolvePendingMainChatWorkPanelOpen(
      { ...pending, minimumRevision: 0, registrationId: "", webContentsId: 0 },
      { ...committed, revision: 1 },
      pending.routeKey,
    ),
    "complete",
  );
});
