import test from "node:test";
import assert from "node:assert/strict";

const {
  createQuitConfirmationController
} = await import("../dist-electron/main/modules/shell/quit-confirmation.js");

const messages = {
  "common.cancel": "Cancel",
  "quitConfirm.title": "Quit now?",
  "quitConfirm.quit": "Quit",
  "quitConfirm.detail": "Quitting will interrupt active local tasks and services."
};

function t(key) {
  return messages[key] ?? key;
}

test("Windows quit confirmation cancels without requesting app quit", async () => {
  const ownerWindow = { isDestroyed: () => false };
  const dialogs = [];
  let quitRequests = 0;
  const controller = createQuitConfirmationController({
    platform: "win32",
    t,
    getOwnerWindow: () => ownerWindow,
    showMessageBox: async (options, owner) => {
      dialogs.push({ options, owner });
      return { response: 0 };
    },
    requestQuitWithoutConfirmation: () => {
      quitRequests += 1;
    }
  });

  await controller.confirmAndRequestAppQuit();

  assert.equal(dialogs.length, 1);
  assert.equal(dialogs[0].owner, ownerWindow);
  assert.equal(dialogs[0].options.defaultId, 0);
  assert.equal(dialogs[0].options.cancelId, 0);
  assert.equal(quitRequests, 0);
});

test("Windows quit confirmation confirms once across concurrent close requests", async () => {
  let resolveDialog;
  let dialogRequests = 0;
  let quitRequests = 0;
  const controller = createQuitConfirmationController({
    platform: "win32",
    t,
    getOwnerWindow: () => null,
    showMessageBox: () => {
      dialogRequests += 1;
      return new Promise((resolve) => {
        resolveDialog = resolve;
      });
    },
    requestQuitWithoutConfirmation: () => {
      quitRequests += 1;
    }
  });

  const firstRequest = controller.confirmAndRequestAppQuit();
  const secondRequest = controller.confirmAndRequestAppQuit();
  await Promise.resolve();

  assert.equal(dialogRequests, 1);
  resolveDialog({ response: 1 });
  await Promise.all([firstRequest, secondRequest]);

  assert.equal(quitRequests, 1);
});

test("macOS keeps confirmation and unsupported platforms quit directly", async () => {
  let dialogRequests = 0;
  let macQuitRequests = 0;
  const macController = createQuitConfirmationController({
    platform: "darwin",
    t,
    getOwnerWindow: () => null,
    showMessageBox: async () => {
      dialogRequests += 1;
      return { response: 1 };
    },
    requestQuitWithoutConfirmation: () => {
      macQuitRequests += 1;
    }
  });

  await macController.confirmAndRequestAppQuit();

  let linuxQuitRequests = 0;
  const linuxController = createQuitConfirmationController({
    platform: "linux",
    t,
    getOwnerWindow: () => null,
    showMessageBox: async () => {
      throw new Error("Linux should skip quit confirmation");
    },
    requestQuitWithoutConfirmation: () => {
      linuxQuitRequests += 1;
    }
  });

  await linuxController.confirmAndRequestAppQuit();

  assert.equal(dialogRequests, 1);
  assert.equal(macQuitRequests, 1);
  assert.equal(linuxQuitRequests, 1);
});
