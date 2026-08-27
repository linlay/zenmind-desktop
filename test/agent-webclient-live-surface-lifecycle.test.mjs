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
