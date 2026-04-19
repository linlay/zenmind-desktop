import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { summarizeCoreServices } = require("../dist-electron/shared/control-center.js");

function createService(overrides = {}) {
  return {
    id: "service-id",
    name: "service-name",
    kind: "builtin",
    version: "0.1.0",
    description: "",
    installDir: "",
    installed: false,
    status: "not-installed",
    statusLabel: "未安装",
    message: "",
    frontendMode: "none",
    configFiles: [],
    healthMeta: {
      pid: null,
      pidFilePath: "",
      logFilePath: "",
      errorLogFilePath: "",
      webUrl: "",
      port: null,
      prerequisites: []
    },
    ...overrides
  };
}

test("summarizeCoreServices returns core services in quick-start order and tracks missing installs", () => {
  const summary = summarizeCoreServices([
    createService({ id: "plugin-1", name: "示例插件", kind: "plugin", installed: true, status: "running" }),
    createService({ id: "auth", name: "认证服务", installed: true, status: "stopped" }),
    createService({ id: "webclient", name: "小宅助理", installed: false, status: "not-installed" }),
    createService({ id: "hub", name: "Container Hub", installed: true, status: "running" }),
    createService({ id: "platform", name: "智能体平台", installed: true, status: "stopped" })
  ]);

  assert.equal(summary.expectedCount, 3);
  assert.equal(summary.installedCount, 3);
  assert.deepEqual(summary.coreServices.map((service) => service.name), [
    "Container Hub",
    "智能体平台",
    "认证服务"
  ]);
  assert.deepEqual(summary.missingInstallServices.map((service) => service.id), []);
});

test("summarizeCoreServices reports no missing installs when all core services are installed", () => {
  const summary = summarizeCoreServices([
    createService({ id: "hub", name: "Container Hub", installed: true, status: "running" }),
    createService({ id: "platform", name: "智能体平台", installed: true, status: "running" }),
    createService({ id: "webclient", name: "小宅助理", installed: true, status: "stopped" }),
    createService({ id: "auth", name: "认证服务", installed: true, status: "stopped" })
  ]);

  assert.equal(summary.installedCount, 3);
  assert.deepEqual(summary.missingInstallServices, []);
});
