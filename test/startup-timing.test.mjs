import test from "node:test";
import assert from "node:assert/strict";

const {
  __testInternals
} = await import("../dist-electron/main/startup-timing.js");

test("startup timing summary renders phases as an ASCII bar chart", () => {
  const events = [
    {
      phase: "loadBuiltinServices",
      metadata: {},
      durationMs: 25,
      startedAt: "2026-05-26T00:00:00.000Z",
      endedAt: "2026-05-26T00:00:00.025Z"
    },
    {
      phase: "installBuiltinService",
      metadata: { serviceId: "agent-platform" },
      durationMs: 100,
      startedAt: "2026-05-26T00:00:00.025Z",
      endedAt: "2026-05-26T00:00:00.125Z"
    }
  ];

  const lines = __testInternals.formatStartupTimingSummary(events);

  assert.equal(lines[0], "[startup-timing] summary total=125ms count=2");
  assert.match(lines[1], /loadBuiltinServices\s+25ms\s+########/u);
  assert.match(lines[2], /installBuiltinService serviceId=agent-platform\s+100ms\s+################################/u);
});

test("startup timing summary reports an empty timing window", () => {
  assert.deepEqual(__testInternals.formatStartupTimingSummary([]), [
    "[startup-timing] summary total=0ms count=0"
  ]);
});

test("startup timing summary aggregates noisy container engine checks", () => {
  const events = [
    {
      phase: "containerEngineAvailable",
      metadata: { engine: "none" },
      durationMs: 1,
      startedAt: "2026-05-26T00:00:00.000Z",
      endedAt: "2026-05-26T00:00:00.001Z"
    },
    {
      phase: "containerEngineAvailable",
      metadata: { engine: "none" },
      durationMs: 3,
      startedAt: "2026-05-26T00:00:00.001Z",
      endedAt: "2026-05-26T00:00:00.004Z"
    },
    {
      phase: "runServiceCommand",
      metadata: { serviceId: "agent-platform", command: "start.ps1" },
      durationMs: 100,
      startedAt: "2026-05-26T00:00:00.004Z",
      endedAt: "2026-05-26T00:00:00.104Z"
    }
  ];

  const lines = __testInternals.formatStartupTimingSummary(events);

  assert.equal(lines.length, 3);
  assert.equal(lines[0], "[startup-timing] summary total=104ms count=3");
  assert.match(lines[1], /containerEngineAvailable engine=none count=2 avgMs=2 maxMs=3\s+4ms/u);
  assert.match(lines[2], /runServiceCommand serviceId=agent-platform command=start\.ps1\s+100ms/u);
});

test("startup timing can record noisy phases without immediate log output", () => {
  const originalInfo = console.info;
  const lines = [];
  console.info = (...args) => {
    lines.push(args.join(" "));
  };

  try {
    const event = __testInternals.recordStartupTiming(
      "containerEngineAvailable",
      { engine: "none" },
      1,
      "2026-05-26T00:00:00.000Z",
      "2026-05-26T00:00:00.001Z",
      { log: false }
    );

    assert.equal(event.phase, "containerEngineAvailable");
    assert.deepEqual(lines, []);
  } finally {
    console.info = originalInfo;
    __testInternals.clearStartupTimingEvents();
  }
});
