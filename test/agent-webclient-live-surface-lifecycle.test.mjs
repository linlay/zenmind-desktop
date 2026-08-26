import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts) => readFileSync(path.join(projectRoot, ...parts), "utf8");

test("Desktop live Chat and trusted WorkPanel child surfaces publish active lifecycle to their mounted guest", () => {
  const surface = read("src", "renderer", "service-webview", "ServiceWebviewSurface.tsx");
  for (const surfaceIdConstant of [
    "MAIN_CHAT_SURFACE_ID",
    "COPILOT_DOCK_SURFACE_ID",
    "KANBAN_CHAT_SURFACE_ID",
  ]) {
    assert.match(surface, new RegExp(`\\b${surfaceIdConstant}\\b`));
  }
  assert.match(surface, /DESKTOP_SURFACE_ACTIVE_CHANGED_MESSAGE_TYPE/);
  assert.match(surface, /AGENT_WEBCLIENT_WORK_PANEL_ROLES/u);
  assert.match(surface, /surfaceIdentity\.parentSurfaceId === MAIN_CHAT_SURFACE_ID/u);
  assert.match(surface, /isAgentWebclientLifecycleSurface\(serviceId, surfaceId, surfaceIdentity\)/u);
  assert.match(
    surface,
    /if \(!registrationActive\) \{[\s\S]*?sendLiveSurfaceLifecycleToWebview\(false\)[\s\S]*?registerSurface\(registration\)/,
  );
  assert.match(
    surface,
    /registerSurface\(registration\)\.then\(\(result\) => \{[\s\S]*?if \(result\.ok\) \{[\s\S]*?if \(registrationActive\) \{[\s\S]*?sendLiveSurfaceLifecycleToWebview\(true\)/,
  );
  assert.match(surface, /return \(\) => sendLiveSurfaceLifecycleToWebview\(false\)/);
});

test("main Chat metadata refreshes do not replay active lifecycle for the same mounted guest", () => {
  const surface = read("src", "renderer", "service-webview", "ServiceWebviewSurface.tsx");
  const lifecycleSender = surface.slice(
    surface.indexOf("function sendLiveSurfaceLifecycleToWebview"),
    surface.indexOf("function dispatchServiceWebviewRouteEventToWebview"),
  );
  const lifecycleCleanupEffect = lifecycleSender.slice(
    lifecycleSender.indexOf("const liveSurfaceLifecycleEnabled"),
  );

  assert.match(surface, /lastLiveSurfaceLifecycleRef/u);
  assert.match(lifecycleSender, /const webContentsId = readWebviewContentsId\(webviewRef\.current\)/u);
  assert.match(
    lifecycleSender,
    /previous\?\.active === nextActive[\s\S]*?previous\.webContentsId === webContentsId[\s\S]*?return;/u,
  );
  assert.match(lifecycleCleanupEffect, /liveSurfaceLifecycleEnabled/u);
  assert.doesNotMatch(lifecycleCleanupEffect, /surfaceIdentity\.ownerChatId/u);
});

test("Agent WebClient management routes reuse one retained guest", () => {
  const hosts = read(
    "src",
    "renderer",
    "app-shell",
    "embedded-surfaces",
    "EmbeddedSurfaceHosts.tsx",
  );
  const appShell = read("src", "renderer", "app-shell", "AppShell.tsx");

  assert.match(hosts, /lastManagementRouteRef/u);
  assert.match(
    hosts,
    /activeAgentWebclientRouteKind === "management"[\s\S]*?lastManagementRouteRef\.current = activeAgentWebclientRoute/u,
  );
  assert.match(
    hosts,
    /key=\{AGENT_WEBCLIENT_SERVICE_ID\}[\s\S]*?desktopRoute=\{managementRoute\?\.routePath\}/u,
  );
  assert.match(hosts, /agentManagementSurfaceMounted/u);
  assert.match(appShell, /setAgentManagementSurfaceMounted\(true\)/u);
  assert.match(
    appShell,
    /agentManagementSurfaceMounted=\{agentManagementSurfaceMounted\}/u,
  );
});

test("sleeping external guests retain lightweight tab state without retaining guest ids", () => {
  const hosts = read(
    "src",
    "renderer",
    "app-shell",
    "embedded-surfaces",
    "EmbeddedSurfaceHosts.tsx",
  );
  const externalWebview = read(
    "src",
    "renderer",
    "pages",
    "external-webview",
    "ExternalWebviewPage.tsx",
  );

  assert.match(hosts, /runtimeSnapshotsRef/u);
  assert.match(hosts, /initialRuntimeSnapshot=\{runtimeSnapshotsRef\.current\.get\(entryKey\)\}/u);
  assert.match(hosts, /onRuntimeSnapshotChange=\{\(snapshot\) =>/u);
  assert.match(externalWebview, /export type ExternalWebviewRuntimeSnapshot/u);
  assert.match(externalWebview, /title: tab\.title,[\s\S]*?currentUrl: tab\.currentUrl/u);
  assert.doesNotMatch(
    externalWebview.slice(
      externalWebview.indexOf("export type ExternalWebviewRuntimeSnapshot"),
      externalWebview.indexOf("type ExternalWebviewPageProps"),
    ),
    /guestId|webContentsId/u,
  );
});

test("downloads protect the initiating guest until Electron reports completion", () => {
  const mainRuntime = read("src", "main", "app", "runtime.ts");
  const preload = read("src", "preload", "index.ts");
  const serviceSurface = read(
    "src",
    "renderer",
    "service-webview",
    "ServiceWebviewSurface.tsx",
  );
  const externalWebview = read(
    "src",
    "renderer",
    "pages",
    "external-webview",
    "ExternalWebviewPage.tsx",
  );

  assert.match(mainRuntime, /targetSession\.on\("will-download"/u);
  assert.match(mainRuntime, /publishDownloadState\(true\)/u);
  assert.match(mainRuntime, /item\.once\("done", \(\) => publishDownloadState\(false\)\)/u);
  assert.match(preload, /onSurfaceRuntimeDownloadState/u);
  assert.match(serviceSurface, /download:\$\{state\.downloadId\}/u);
  assert.match(externalWebview, /runtimeDownloadTabIdsRef/u);
});
