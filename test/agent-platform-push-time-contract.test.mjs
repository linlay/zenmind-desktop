import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  readAgentPlatformPushEpochMillis,
  validateAgentPlatformPushTimeContract,
} = require("../dist-electron/shared/agent-platform-push-time-contract.js");

const EPOCH_MS = 1_783_000_000_000;

test("agent-platform push time contract accepts every documented push shape", () => {
  const cases = [
    ["connected", {}, undefined],
    ["heartbeat", { timestamp: EPOCH_MS }, EPOCH_MS],
    ["auth.expiring", { expiresAt: EPOCH_MS }, EPOCH_MS],
    ["run.started", { startedAt: EPOCH_MS }, EPOCH_MS],
    ["run.finished", { finishedAt: EPOCH_MS }, EPOCH_MS],
    ["chat.created", { createdAt: EPOCH_MS }, EPOCH_MS],
    ["chat.updated", { updatedAt: EPOCH_MS }, EPOCH_MS],
    ["chat.unread", { createdAt: EPOCH_MS }, EPOCH_MS],
    ["chat.read", { readAt: EPOCH_MS }, EPOCH_MS],
    ["chat.read_all", {}, undefined],
    ["chat.deleted", {}, undefined],
    ["chat.renamed", {}, undefined],
    ["chat.archived", {}, undefined],
    ["archive.restored", {
      summary: {
        createdAt: EPOCH_MS,
        updatedAt: EPOCH_MS,
        lastRunAt: EPOCH_MS,
        archivedAt: EPOCH_MS,
        readAt: null,
      },
    }, undefined],
    ["archive.deleted", {}, undefined],
    ["catalog.updated", { updatedAt: EPOCH_MS }, EPOCH_MS],
    ["awaiting.asking", { createdAt: EPOCH_MS, timeout: 600 }, EPOCH_MS],
    ["awaiting.answered", { answeredAt: EPOCH_MS, durationMs: 600 }, EPOCH_MS],
    ["resource.pushed", { pushedAt: EPOCH_MS }, EPOCH_MS],
  ];

  for (const [type, data, expectedTime] of cases) {
    assert.equal(validateAgentPlatformPushTimeContract(type, data), undefined, type);
    assert.equal(readAgentPlatformPushEpochMillis(type, data), expectedTime, type);
  }
  assert.equal(readAgentPlatformPushEpochMillis("run.start", { startedAt: EPOCH_MS }), EPOCH_MS);
  assert.equal(readAgentPlatformPushEpochMillis("run.complete", { finishedAt: EPOCH_MS }), EPOCH_MS);
});

test("agent-platform push time contract rejects missing, malformed, and legacy time fields", () => {
  assert.equal(validateAgentPlatformPushTimeContract("run.started", {}), "startedAt");
  assert.equal(validateAgentPlatformPushTimeContract("archive.restored", {}), "summary");
  assert.equal(
    validateAgentPlatformPushTimeContract("archive.restored", {
      summary: { createdAt: EPOCH_MS, updatedAt: EPOCH_MS, lastRunAt: EPOCH_MS },
    }),
    "summary.archivedAt",
  );

  for (const createdAt of [
    "2026-07-14T00:00:00.000Z",
    String(EPOCH_MS),
    EPOCH_MS / 1_000,
    EPOCH_MS + 0.5,
    -1,
  ]) {
    assert.equal(
      validateAgentPlatformPushTimeContract("chat.created", { createdAt }),
      "createdAt",
    );
  }
  assert.equal(
    validateAgentPlatformPushTimeContract("archive.restored", {
      summary: {
        createdAt: EPOCH_MS,
        updatedAt: EPOCH_MS,
        lastRunAt: EPOCH_MS / 1_000,
        archivedAt: EPOCH_MS,
      },
    }),
    "summary.lastRunAt",
  );
  assert.equal(
    validateAgentPlatformPushTimeContract("chat.created", {
      createdAt: EPOCH_MS,
      timestamp: EPOCH_MS,
    }),
    "timestamp",
  );
  assert.equal(
    validateAgentPlatformPushTimeContract("awaiting.answered", {
      answeredAt: EPOCH_MS,
      resolvedAt: EPOCH_MS,
      durationMs: 120,
    }),
    undefined,
  );
});
