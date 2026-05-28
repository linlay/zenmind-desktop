import test from "node:test";
import assert from "node:assert/strict";

const {
  createStartupRestoreController
} = await import("../dist-electron/main/startup-restore.js");

test("startup restore controller emits cloned state as core services progress", () => {
  const emittedStates = [];
  const controller = createStartupRestoreController({
    serviceOrder: ["zenmind-app-server", "agent-platform", "agent-webclient"],
    onChange: (state) => emittedStates.push(state)
  });

  controller.beginSession("restore");
  controller.updateService("zenmind-app-server", "starting", "starting app server");
  controller.updateService("zenmind-app-server", "succeeded");
  controller.updateService("agent-platform", "succeeded");
  controller.updateService("agent-webclient", "succeeded");

  const state = controller.getState();
  assert.equal(state.phase, "succeeded");
  assert.equal(state.currentServiceId, null);
  assert.deepEqual(
    state.services.map((service) => [service.serviceId, service.phase]),
    [
      ["zenmind-app-server", "succeeded"],
      ["agent-platform", "succeeded"],
      ["agent-webclient", "succeeded"]
    ]
  );

  emittedStates[0].phase = "failed";
  assert.equal(controller.getState().phase, "succeeded");
});
