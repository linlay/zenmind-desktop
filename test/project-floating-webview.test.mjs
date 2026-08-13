import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function read(relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath), "utf8");
}

test("project agents expose the native project-editor action with mode-aware eligibility", () => {
  const sidebar = read("src/renderer/app-shell/navigation/AppSidebar.tsx");
  const policy = read("src/main/sidebar-context-menu-policy.ts");
  const handler = read("src/main/ipc/sidebar-context-menu-handlers.ts");
  const enUS = read("src/shared/i18n/dictionaries/enUS.ts");
  const zhCN = read("src/shared/i18n/dictionaries/zhCN.ts");

  assert.match(
    sidebar,
    /canOpenProjectEditor:[\s\S]{0,120}canOpenAgentProjectEditor\(agent\)/,
  );
  assert.match(
    sidebar,
    /function canOpenAgentProjectEditor[\s\S]*?mode === "KBASE"[\s\S]*?return true[\s\S]*?mode === "CODER" && !getRevealWorkspaceDisabledReason\(agent\)/,
  );
  assert.match(
    sidebar,
    /actionId === "agent\.open-project-editor"[\s\S]*?onOpenAgentProjectEditor\?\.\(agent\)/,
  );
  assert.match(
    policy,
    /id: "agent\.reveal-workspace"[\s\S]*?id: "agent\.open-project-editor"[\s\S]*?id: "agent\.edit"/,
  );
  assert.match(handler, /"agent\.open-project-editor": "sidebar\.agent\.openProjectEditor"/);
  assert.match(enUS, /"sidebar\.agent\.openProjectEditor": "Open project editor"/);
  assert.match(zhCN, /"sidebar\.agent\.openProjectEditor": "打开项目编辑器"/);
  assert.match(sidebar, /desktopShell\.revealPath\(workspaceDir\)/);
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
