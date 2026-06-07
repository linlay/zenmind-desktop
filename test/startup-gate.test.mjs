import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  getStartupBlockingService,
  isStartupServiceWaiting,
  resolveStartupRootPath,
  shouldAutoOpenAssistant,
  shouldRedirectStartupFailureToControlCenter,
  shouldShowStartupProgressCard
} = require("../dist-electron/shared/startup-gate.js");

test("startup gate treats only not-installed and stopped as waiting states", () => {
  assert.equal(isStartupServiceWaiting(null), true);
  assert.equal(isStartupServiceWaiting({ status: "not-installed" }), true);
  assert.equal(isStartupServiceWaiting({ status: "stopped" }), true);
  assert.equal(isStartupServiceWaiting({ status: "initialization-required" }), false);
  assert.equal(isStartupServiceWaiting({ status: "config-required" }), false);
  assert.equal(isStartupServiceWaiting({ status: "dependency-missing" }), false);
  assert.equal(isStartupServiceWaiting({ status: "error" }), false);
});

test("startup gate redirects to control center when a startup service is blocked", () => {
  const blocked = getStartupBlockingService([
    { id: "zenmind-app-server", status: "running" },
    { id: "agent-platform", status: "dependency-missing" },
    { id: "agent-webclient", status: "stopped" }
  ], false);

  assert.ok(blocked);
  assert.equal(blocked.id, "agent-platform");
});

test("startup gate keeps waiting while services are still loading or starting", () => {
  assert.equal(getStartupBlockingService([
    { id: "zenmind-app-server", status: "running" },
    { id: "agent-platform", status: "stopped" }
  ], true), null);

  assert.equal(getStartupBlockingService([
    { id: "zenmind-app-server", status: "running" },
    { id: "agent-platform", status: "not-installed" },
    null
  ], false), null);
});

test("startup gate shows the bootstrap progress card only while bootstrap needs attention", () => {
  assert.equal(shouldShowStartupProgressCard(null, false), true);
  assert.equal(shouldShowStartupProgressCard(null, true), false);
  assert.equal(shouldShowStartupProgressCard({ mode: "restore", phase: "running" }, false), true);
  assert.equal(shouldShowStartupProgressCard({ mode: "restore", phase: "running" }, true), false);
  assert.equal(shouldShowStartupProgressCard({ mode: "bootstrap", phase: "running" }, false), true);
  assert.equal(shouldShowStartupProgressCard({ mode: "bootstrap", phase: "failed" }, false), true);
  assert.equal(shouldShowStartupProgressCard({ mode: "bootstrap", phase: "failed" }, false, "/settings"), false);
  assert.equal(shouldShowStartupProgressCard({ mode: "bootstrap", phase: "succeeded" }, false), false);
  assert.equal(shouldShowStartupProgressCard({ mode: "bootstrap", phase: "succeeded" }, true), false);
  assert.equal(shouldShowStartupProgressCard({ mode: "bootstrap", phase: "env-import-required" }, false), false);
});

test("startup gate routes root traffic to control center during bootstrap and task board otherwise", () => {
  assert.equal(resolveStartupRootPath(null, false), null);
  assert.equal(resolveStartupRootPath({ mode: "bootstrap", phase: "running" }, false), "/control-center");
  assert.equal(resolveStartupRootPath({ mode: "bootstrap", phase: "succeeded" }, true), "/kanban");
  assert.equal(resolveStartupRootPath({ mode: "restore", phase: "running" }, false), "/kanban");
  assert.equal(resolveStartupRootPath({ phase: "env-import-required" }, false), "/control-center");
});

test("startup gate only auto-opens the assistant after bootstrap succeeds", () => {
  assert.equal(shouldAutoOpenAssistant(null, false), false);
  assert.equal(shouldAutoOpenAssistant({ mode: "restore", phase: "succeeded" }, true), false);
  assert.equal(shouldAutoOpenAssistant({ mode: "bootstrap", phase: "running" }, true), false);
  assert.equal(shouldAutoOpenAssistant({ mode: "bootstrap", phase: "succeeded" }, true), true);
  assert.equal(shouldAutoOpenAssistant({ mode: "bootstrap", phase: "succeeded" }, true, "/control-center"), true);
  assert.equal(shouldAutoOpenAssistant({ mode: "bootstrap", phase: "succeeded" }, true, "/market"), false);
});

test("startup gate does not pull settings back into bootstrap failure handling", () => {
  const failedBootstrapState = {
    mode: "bootstrap",
    phase: "failed"
  };

  assert.equal(shouldRedirectStartupFailureToControlCenter(failedBootstrapState, "/"), true);
  assert.equal(shouldRedirectStartupFailureToControlCenter(failedBootstrapState, "/control-center"), true);
  assert.equal(shouldRedirectStartupFailureToControlCenter(failedBootstrapState, "/settings"), false);
});

test("startup loading only shows previous-service waiting while app-server is starting", () => {
  const source = fs.readFileSync(
    path.resolve(import.meta.dirname, "../src/renderer/app-shell/startup/StartupGate.tsx"),
    "utf8"
  );

  assert.match(source, /const waitingForStartupDependency =[\s\S]*appServerStartupPhase === "starting"/u);
  assert.doesNotMatch(source, /slice\(0,\s*index\)/u);
});

test("startup shell avoids a blank white first frame", () => {
  const mainProcessSource = fs.readFileSync(
    path.resolve(import.meta.dirname, "../src/main/index.ts"),
    "utf8"
  );
  const startupStyles = fs.readFileSync(
    path.resolve(import.meta.dirname, "../src/renderer/styles/navigation.css"),
    "utf8"
  );
  const readyToShowBlock = mainProcessSource.match(/app\.whenReady\(\)\.then\([\s\S]*?app\.on\("activate"/u)?.[0] ?? "";

  assert.doesNotMatch(readyToShowBlock, /ready-to-show[\s\S]{0,240}handleStartupPipeline/u);
  assert.match(readyToShowBlock, /void handleStartupPipeline\(\);/u);
  assert.match(startupStyles, /\.startup-loading-screen\s*\{[\s\S]*?background:\s*#f6f8fc;/u);
});
