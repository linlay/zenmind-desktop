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
    frontend: {
      mode: "none"
    },
    frontendMode: "none",
    desktop: {},
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
    createService({
      id: "zenmind-app-server",
      name: "认证服务",
      installed: true,
      status: "stopped",
      desktop: { displayOrder: 4 }
    }),
    createService({
      id: "webclient",
      name: "小宅助理",
      installed: false,
      status: "not-installed",
      desktop: { displayOrder: 3 }
    }),
    createService({
      id: "agent-container-hub",
      name: "Container Hub",
      installed: true,
      status: "running",
      desktop: { displayOrder: 1 }
    }),
    createService({
      id: "agent-platform",
      name: "智能体平台",
      installed: true,
      status: "stopped",
      desktop: { displayOrder: 2 }
    })
  ]);

  assert.equal(summary.expectedCount, 4);
  assert.equal(summary.installedCount, 3);
  assert.deepEqual(summary.coreServices.map((service) => service.name), [
    "Container Hub",
    "智能体平台",
    "小宅助理",
    "认证服务"
  ]);
  assert.deepEqual(summary.missingInstallServices.map((service) => service.id), ["webclient"]);
});

test("summarizeCoreServices reports no missing installs when all core services are installed", () => {
  const summary = summarizeCoreServices([
    createService({ id: "agent-container-hub", name: "Container Hub", installed: true, status: "running" }),
    createService({ id: "agent-platform", name: "智能体平台", installed: true, status: "running" }),
    createService({ id: "webclient", name: "小宅助理", installed: true, status: "stopped" }),
    createService({ id: "zenmind-app-server", name: "认证服务", installed: true, status: "stopped" })
  ]);

  assert.equal(summary.expectedCount, 4);
  assert.equal(summary.installedCount, 4);
  assert.deepEqual(summary.missingInstallServices, []);
});

test("summarizeCoreServices sorts builtins by desktop.displayOrder and places unspecified order last", () => {
  const summary = summarizeCoreServices([
    createService({
      id: "agent-webclient",
      name: "小宅助理",
      installed: true,
      status: "running",
      desktop: { displayOrder: 3 }
    }),
    createService({
      id: "agent-platform",
      name: "智能体平台",
      installed: true,
      status: "running",
      desktop: { displayOrder: 2 }
    }),
    createService({
      id: "agent-container-hub",
      name: "Container Hub",
      installed: true,
      status: "running",
      desktop: { displayOrder: 1 }
    }),
    createService({
      id: "zenmind-app-server",
      name: "认证服务",
      installed: true,
      status: "stopped"
    })
  ]);

  assert.equal(summary.installedCount, 4);
  assert.deepEqual(summary.coreServices.map((service) => service.id), [
    "agent-container-hub",
    "agent-platform",
    "agent-webclient",
    "zenmind-app-server"
  ]);
});
