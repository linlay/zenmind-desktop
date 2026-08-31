import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const {
  buildWebappSettingsPath,
  readSettingsWebappId
} = await import("../dist-electron/shared/settings-routes.js");
const { readWebappPublishState } = await import("../dist-electron/main/webs/webapps/publisher.js");
const { getDesktopWebappStateRoot } = await import("../dist-electron/main/user-paths.js");

function read(relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath), "utf8");
}

test("WebApp lifecycle actions keep install, runtime, and Tunnel publishing separate", () => {
  const catalog = read("src/shared/desktop-actions.ts");
  const bridge = read("src/main/desktop-action-bridge.ts");
  const webappActions = read("src/main/webs/webapps/actions.ts");
  const wsServer = read("src/main/desktop-ws-server.ts");
  const wsContract = read("src/shared/desktop-ws.ts");

  for (const action of [
    "desktop.webapp.install",
    "desktop.webapp.checkRuntime",
    "desktop.webapp.getPublishStatus",
    "desktop.webapp.publish",
    "desktop.webapp.unpublish",
    "desktop.webapp.uninstall"
  ]) {
    assert.match(catalog, new RegExp(action.replaceAll(".", "\\."), "u"));
    assert.match(bridge, new RegExp(action.replaceAll(".", "\\."), "u"));
  }
  for (const removedAction of [
    "desktop.webapp.installAndOpen",
    "desktop.webapp.selectDirectory",
    "desktop.webapp.checkPrerequisites",
    "desktop.webapp.getPublishInfo"
  ]) {
    assert.doesNotMatch(catalog, new RegExp(removedAction.replaceAll(".", "\\."), "u"));
  }
  const installHandler = bridge.slice(
    bridge.indexOf("async function installWebapp"),
    bridge.indexOf("async function executeWebAction")
  );
  assert.match(installHandler, /webappManager\.installArchive/u);
  assert.match(installHandler, /operation/u);
  assert.doesNotMatch(installHandler, /webappRuntime\.start/u);
  assert.doesNotMatch(installHandler, /navigate/u);
  assert.doesNotMatch(installHandler, /mobilePublish|readDesktopMobileWebappItem/u);
  assert.match(bridge, /webapp_install_not_visible/u);
  assert.match(bridge, /runtimeState\.status !== "running" \|\| !runtimeState\.webUrl/u);
  assert.match(bridge, /webapp_not_running/u);
  assert.match(
    webappActions,
    /unpublishWebapp\(app, target\.id\)[\s\S]*?webappRuntime\.stop\(app, target\.id[\s\S]*?closeForDisposal\(target\.id\)[\s\S]*?fs\.rmSync\(target\.installPath/u
  );
  assert.match(wsContract, /"webapp\.list"/u);
  assert.match(wsContract, /"webapp\.changed"/u);
  for (const alias of [
    "webapp.install",
    "webapp.checkRuntime",
    "webapp.getPublishStatus",
    "webapp.publish",
    "webapp.unpublish",
    "webapp.uninstall"
  ]) {
    const pattern = new RegExp(alias.replaceAll(".", "\\."), "u");
    assert.match(wsServer, pattern);
    assert.match(wsContract, pattern);
  }
  assert.doesNotMatch(wsServer, /webapp\.installAndOpen|webapp\.checkPrerequisites|webapp\.getPublishInfo/u);
});

test("mobile WebApp catalog derives m URLs while manual publishing remains on the wa route API", () => {
  const mobileAccess = read("src/main/webs/webapps/mobile-access.ts");
  const mobileCatalog = read("src/main/webs/webapps/mobile-catalog.ts");
  const publisher = read("src/main/webs/webapps/publisher.ts");

  assert.match(mobileAccess, /readTunnelHubSettings/u);
  assert.match(mobileAccess, /url\.hostname = mobileWebappHost/u);
  assert.match(mobileAccess, /url\.pathname = "\/"/u);
  assert.match(mobileAccess, /-\$\{frontendPort\}/u);
  assert.match(mobileAccess, /isMobileTunnelHost/u);
  assert.match(mobileCatalog, /createMobileTunnelWebappUrl/u);
  assert.doesNotMatch(mobileCatalog, /readWebappPublishState/u);
  assert.match(publisher, /\/api\/desktop\/devices\/\$\{encodeURIComponent\(settings\.deviceId\)\}\/webapps\//u);
  assert.match(publisher, /registerTunnelRoute\(app, item, runtime\.webUrl, true\)/u);
});

test("Settings exposes one-click Tunnel publishing and mobile QR sharing", () => {
  const page = read("src/renderer/pages/settings/SettingsPage.tsx");
  const styles = read("src/renderer/pages/settings/SettingsPage.css");

  assert.match(page, /onClick=\{\(\) => void handlePublishWebapp\(selectedWebapp\)\}/u);
  assert.match(page, /webapps\.start\(item\.id\)[\s\S]*?webapps\.publish\(item\.id\)/u);
  assert.doesNotMatch(page, /disabled=\{!publishReady \|\| webappPublishPendingId !== ""\}/u);
  assert.match(page, /<QRCode[\s\S]*?value=\{publishState\.url\}/u);
  assert.match(page, /handleCopyWebappPublishUrl/u);
  assert.match(page, /buildSettingsSectionPath\("tunnelHub"\)/u);
  assert.match(styles, /\.web-publish-share-card[\s\S]*?@media \(max-width: 760px\)/u);
});

test("sidebar WebApp sharing uses cached publication state and targeted settings navigation", () => {
  const handlers = read("src/main/ipc/web-handlers.ts");
  const runtime = read("src/main/bridge/assistant-runtime.ts");
  const appShell = read("src/renderer/app-shell/AppShell.tsx");
  const sidebar = read("src/renderer/app-shell/navigation/AppSidebar.tsx");
  const settings = read("src/renderer/pages/settings/SettingsPage.tsx");

  assert.match(handlers, /webappPublishStates:[\s\S]*?readWebappPublishState/u);
  assert.match(runtime, /webContents\.send\("webs\.changed", \{[\s\S]*?webappId,[\s\S]*?reason/u);
  assert.match(appShell, /WEBAPP_PUBLISH_CHANGE_REASONS[\s\S]*?refreshWebappPublishState\(event\.webappId\)/u);
  assert.match(sidebar, /runtime\.webappPublishStateById\[item\.id\]/u);
  assert.match(sidebar, /actionId === "web\.copy-share-url"[\s\S]*?copyWebappShareUrl\(publicUrl\)/u);
  assert.match(sidebar, /buildWebappSettingsPath\(item\.id\)/u);
  assert.match(settings, /readSettingsWebappId\(location\.search\)/u);
  assert.doesNotMatch(settings, /const otherWebapps = webappItems\.filter/u);
  assert.doesNotMatch(appShell, /setInterval\([\s\S]*?getPublishStatus/u);
});

test("WebApp settings deep links encode and recover a selected application", () => {
  const route = buildWebappSettingsPath(" app/id with spaces ");
  assert.equal(route, "/settings/webapps?webappId=app%2Fid+with+spaces");
  assert.equal(readSettingsWebappId("?webappId=app%2Fid+with+spaces"), "app/id with spaces");
  assert.equal(buildWebappSettingsPath("  "), "/settings/webapps");
  assert.equal(readSettingsWebappId("?unrelated=1"), "");
});

test("missing and damaged WebApp publication files resolve to null", () => {
  const temporaryHome = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-webapp-publish-state-"));
  const app = {
    getPath(name) {
      if (name === "home") {
        return temporaryHome;
      }
      throw new Error(`Unexpected Electron path: ${name}`);
    }
  };
  const webappId = "test-webapp";
  try {
    assert.equal(readWebappPublishState(app, webappId), null);
    const stateRoot = getDesktopWebappStateRoot(app, webappId);
    fs.mkdirSync(stateRoot, { recursive: true });
    fs.writeFileSync(path.join(stateRoot, "publish.json"), "{damaged", "utf8");
    assert.equal(readWebappPublishState(app, webappId), null);
  } finally {
    fs.rmSync(temporaryHome, { recursive: true, force: true });
  }
});

test("bootstrap navigation is consumed once and never OWNER-hands off", () => {
  const appShell = read("src/renderer/app-shell/AppShell.tsx");

  assert.match(appShell, /const firstInstallBootstrapNavigationRequestRef = useRef/u);
  assert.match(appShell, /consumeFirstInstallBootstrapNavigation\(\)/u);
  assert.doesNotMatch(appShell, /bootstrapHandoffNavigationDoneRef|ownerProfileExists/u);
  assert.doesNotMatch(appShell, /window\.setInterval\([\s\S]*?refreshAssistantNavAgents\(\)[\s\S]*?2_000/u);
  assert.doesNotMatch(appShell, /visibleAssistantNavChatItems/u);
  assert.match(appShell, /assistantNavChatItems=\{assistantNavChatItems\}/u);
  assert.match(appShell, /chatDefaultAgentKey=\{chatRuntimeAgent\.agentKey\}/u);
});
