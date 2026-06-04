import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  buildQuitConfirmationDialogOptions,
  createQuitConfirmationController
} = require("../dist-electron/main/app-shell/quit-confirmation.js");

const messages = {
  "common.cancel": "取消",
  "quitConfirm.quit": "退出",
  "quitConfirm.title": "退出 {appName}？",
  "quitConfirm.detail": "本机正在运行的任务和服务将会中断，{appName} 关闭期间已启用的自动化不会运行。"
};

function t(key, params = {}) {
  return messages[key].replace("{appName}", params.appName ?? "");
}

test("buildQuitConfirmationDialogOptions matches the macOS safety prompt copy", () => {
  assert.deepEqual(buildQuitConfirmationDialogOptions({
    appName: "ZenMind",
    t
  }), {
    type: "warning",
    buttons: ["取消", "退出"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: "退出 ZenMind？",
    message: "退出 ZenMind？",
    detail: "本机正在运行的任务和服务将会中断，ZenMind 关闭期间已启用的自动化不会运行。"
  });
});

test("macOS quit confirmation cancels without quitting", async () => {
  let quitCount = 0;
  const calls = [];
  const controller = createQuitConfirmationController({
    platform: "darwin",
    appName: "ZenMind",
    t,
    getOwnerWindow: () => null,
    showMessageBox: async (options, ownerWindow) => {
      calls.push({ options, ownerWindow });
      return { response: 0, checkboxChecked: false };
    },
    requestQuitWithoutConfirmation: () => {
      quitCount += 1;
    }
  });

  await controller.confirmAndRequestAppQuit();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].ownerWindow, null);
  assert.equal(quitCount, 0);
});

test("macOS quit confirmation quits once after explicit confirmation", async () => {
  let quitCount = 0;
  const controller = createQuitConfirmationController({
    platform: "darwin",
    appName: "ZenMind",
    t,
    getOwnerWindow: () => ({ isDestroyed: () => false }),
    showMessageBox: async () => ({ response: 1, checkboxChecked: false }),
    requestQuitWithoutConfirmation: () => {
      quitCount += 1;
    }
  });

  await controller.confirmAndRequestAppQuit();

  assert.equal(quitCount, 1);
});

test("macOS quit confirmation reuses an in-flight dialog", async () => {
  let resolveDialog;
  let dialogCount = 0;
  let quitCount = 0;
  const controller = createQuitConfirmationController({
    platform: "darwin",
    appName: "ZenMind",
    t,
    getOwnerWindow: () => null,
    showMessageBox: async () => {
      dialogCount += 1;
      return new Promise((resolve) => {
        resolveDialog = resolve;
      });
    },
    requestQuitWithoutConfirmation: () => {
      quitCount += 1;
    }
  });

  const first = controller.confirmAndRequestAppQuit();
  const second = controller.confirmAndRequestAppQuit();
  resolveDialog({ response: 1, checkboxChecked: false });
  await Promise.all([first, second]);

  assert.equal(dialogCount, 1);
  assert.equal(quitCount, 1);
});

test("non-macOS quit requests bypass the confirmation dialog", async () => {
  let quitCount = 0;
  let dialogCount = 0;
  const controller = createQuitConfirmationController({
    platform: "win32",
    appName: "ZenMind",
    t,
    getOwnerWindow: () => null,
    showMessageBox: async () => {
      dialogCount += 1;
      return { response: 0, checkboxChecked: false };
    },
    requestQuitWithoutConfirmation: () => {
      quitCount += 1;
    }
  });

  await controller.confirmAndRequestAppQuit();

  assert.equal(dialogCount, 0);
  assert.equal(quitCount, 1);
});
