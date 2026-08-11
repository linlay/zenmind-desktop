import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function read(relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath), "utf8");
}

test("project agents expose the native open-project action with mode-aware eligibility", () => {
  const sidebar = read("src/renderer/app-shell/navigation/AppSidebar.tsx");
  const policy = read("src/main/sidebar-context-menu-policy.ts");
  const handler = read("src/main/ipc/sidebar-context-menu-handlers.ts");
  const enUS = read("src/shared/i18n/dictionaries/enUS.ts");
  const zhCN = read("src/shared/i18n/dictionaries/zhCN.ts");

  assert.match(
    sidebar,
    /canOpenProject:[\s\S]{0,100}canOpenAgentProject\(agent\)/,
  );
  assert.match(
    sidebar,
    /function canOpenAgentProject[\s\S]*?mode === "KBASE"[\s\S]*?return true[\s\S]*?mode === "CODER" && !getOpenWorkspaceDisabledReason\(agent\)/,
  );
  assert.match(
    sidebar,
    /actionId === "agent\.open-project"[\s\S]*?onOpenAgentProject\?\.\(agent\)/,
  );
  assert.match(
    policy,
    /id: "agent\.open-workspace"[\s\S]*?id: "agent\.open-project"[\s\S]*?id: "agent\.edit"/,
  );
  assert.match(handler, /"agent\.open-project": "sidebar\.agent\.openProject"/);
  assert.match(enUS, /"sidebar\.agent\.openProject": "Open project"/);
  assert.match(zhCN, /"sidebar\.agent\.openProject": "打开项目"/);
});

test("AppShell keeps one floating entry per agent and enriches the project route", () => {
  const appShell = read("src/renderer/app-shell/AppShell.tsx");

  assert.match(
    appShell,
    /setProjectFloatingWebviews\(\(current\) => \[[\s\S]*?current\.filter\(\(entry\) => entry\.agentKey !== agentKey\)[\s\S]*?nextEntry/,
  );
  assert.match(
    appShell,
    /createAgentWebclientProjectPath\(\{[\s\S]*?agentKey,[\s\S]*?chatId: preferredChatId,[\s\S]*?runId: preferredChat\?\.lastRunId/,
  );
  assert.match(appShell, /<ProjectFloatingWebviews[\s\S]*?entries=\{projectFloatingWebviews\}/);
});

test("floating project surfaces remain loaded without taking active surface ownership", () => {
  const host = read(
    "src/renderer/app-shell/project/ProjectFloatingWebviews.tsx",
  );
  const surface = read("src/renderer/service-webview/ServiceWebviewSurface.tsx");
  const styles = read("src/renderer/styles/project-floating-webview.css");

  assert.match(
    host,
    /<ServiceWebviewSurface[\s\S]*?active[\s\S]*?surfaceOwnershipActive=\{false\}[\s\S]*?skipContextRegistration/,
  );
  assert.match(host, /createProjectSurfaceId\(entry\.agentKey\)/);
  assert.match(host, /setPointerCapture\(event\.pointerId\)/);
  assert.match(host, /clampFloatingPosition/);
  assert.match(surface, /const ownsActiveSurface = surfaceOwnershipActive \?\? active !== false/);
  assert.match(surface, /active: ownsActiveSurface/);
  assert.match(styles, /\.app-shell\.is-mac-platform \.project-floating-webview/);
  assert.match(styles, /\.app-shell\.is-windows-platform \.project-floating-webview/);
});
