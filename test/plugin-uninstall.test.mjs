import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  __testInternals,
  handlePluginUninstall
} = require("../dist-electron/main/plugin-uninstall.js");

test("buildPluginUninstallDialogOptions uses destructive warning copy", () => {
  const options = __testInternals.buildPluginUninstallDialogOptions("示例插件");

  assert.deepEqual(options, {
    type: "warning",
    buttons: ["取消", "卸载"],
    defaultId: 0,
    cancelId: 0,
    title: "卸载插件",
    message: "确定要卸载插件 示例插件 吗？",
    detail: "插件目录将被删除，此操作不可撤销。"
  });
});

test("handlePluginUninstall returns cancel result without calling uninstall", async () => {
  let uninstallCalled = false;
  let capturedOptions = null;

  const result = await handlePluginUninstall({}, "example-plugin", null, {
    getServiceById: () => ({
      id: "example-plugin",
      name: "示例插件",
      kind: "plugin"
    }),
    showMessageBox: async (...args) => {
      capturedOptions = args.length === 1 ? args[0] : args[1];
      return { response: 0, checkboxChecked: false };
    },
    uninstall: async () => {
      uninstallCalled = true;
      return { ok: true, message: "should not happen" };
    }
  });

  assert.deepEqual(capturedOptions, __testInternals.buildPluginUninstallDialogOptions("示例插件"));
  assert.deepEqual(result, { ok: false, message: "已取消卸载。" });
  assert.equal(uninstallCalled, false);
});

test("handlePluginUninstall confirms before delegating to uninstall", async () => {
  const app = {};
  const ownerWindow = {};
  const calls = [];

  const result = await handlePluginUninstall(app, "example-plugin", ownerWindow, {
    getServiceById: () => ({
      id: "example-plugin",
      name: "示例插件",
      kind: "plugin"
    }),
    showMessageBox: async (windowRef, options) => {
      calls.push({ windowRef, options });
      return { response: 1, checkboxChecked: false };
    },
    uninstall: async (receivedApp, receivedServiceId) => {
      calls.push({ receivedApp, receivedServiceId });
      return { ok: true, message: "插件 示例插件 已卸载。" };
    }
  });

  assert.deepEqual(result, { ok: true, message: "插件 示例插件 已卸载。" });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].windowRef, ownerWindow);
  assert.deepEqual(calls[0].options, __testInternals.buildPluginUninstallDialogOptions("示例插件"));
  assert.equal(calls[1].receivedApp, app);
  assert.equal(calls[1].receivedServiceId, "example-plugin");
});
