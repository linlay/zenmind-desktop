import test from "node:test";
import assert from "node:assert/strict";

const {
  formatStartupStatusText
} = await import("../dist-electron/shared/startup-status.js");

test("startup status text does not repeat service names already present in progress messages", () => {
  assert.equal(formatStartupStatusText("认证服务", "认证服务 启动中..."), "认证服务 启动中...");
  assert.equal(formatStartupStatusText("认证服务", "认证服务：正在初始化..."), "认证服务：正在初始化...");
  assert.equal(formatStartupStatusText("认证服务", "启动中..."), "认证服务 启动中...");
  assert.equal(formatStartupStatusText("认证服务", ""), "认证服务 启动中...");
});
