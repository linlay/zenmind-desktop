import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function read(relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath), "utf8");
}

test("XiaoJun WebApp install exposes direct mobile access without triggering public sharing", () => {
  const catalog = read("src/shared/desktop-actions.ts");
  const bridge = read("src/main/desktop-action-bridge.ts");
  const wsServer = read("src/main/desktop-ws-server.ts");
  const wsContract = read("src/shared/desktop-ws.ts");

  for (const action of [
    "desktop.webapp.installAndOpen",
    "desktop.webapp.getPublishInfo",
    "desktop.webapp.publish",
    "desktop.webapp.unpublish"
  ]) {
    assert.match(catalog, new RegExp(action.replaceAll(".", "\\."), "u"));
    assert.match(bridge, new RegExp(action.replaceAll(".", "\\."), "u"));
  }
  assert.doesNotMatch(catalog, /desktop\.web\.webapps\.installAndOpen/u);
  assert.match(bridge, /notifyWebsChanged\(options\);[\s\S]*?webappRuntime\.start\(options\.app, webappId\)[\s\S]*?options\.navigate\(route\)/u);
  assert.match(bridge, /webapp_install_not_visible/u);
  assert.doesNotMatch(bridge, /hasTunnelWebappSubscriber/u);
  assert.doesNotMatch(bridge, /hasTunnelWebappSubscriber\?\.\(\)[\s\S]*?publishWebapp\(options\.app, webappId, command\.state\)/u);
  assert.match(bridge, /readDesktopMobileWebappItem\(options\.app, webappId\)/u);
  assert.match(bridge, /mobilePublish[\s\S]*?mode:\s*"direct-mobile-tunnel"[\s\S]*?publicUrl/u);
  assert.match(wsContract, /"webapp\.list"/u);
  assert.match(wsContract, /"webapp\.changed"/u);
  for (const alias of [
    "webapp.getPublishInfo",
    "webapp.publish",
    "webapp.unpublish"
  ]) {
    const pattern = new RegExp(alias.replaceAll(".", "\\."), "u");
    assert.match(wsServer, pattern);
    assert.match(wsContract, pattern);
  }
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
  assert.doesNotMatch(page, /disabled=\{!publishReady \|\| webappPublishPendingId !== ""\}/u);
  assert.match(page, /<QRCode[\s\S]*?value=\{publishState\.url\}/u);
  assert.match(page, /handleCopyWebappPublishUrl/u);
  assert.match(page, /buildSettingsSectionPath\("tunnelHub"\)/u);
  assert.match(styles, /\.web-publish-share-card[\s\S]*?@media \(max-width: 760px\)/u);
});

test("bootstrap keeps its Chat visible and hands off at most once per Desktop session", () => {
  const appShell = read("src/renderer/app-shell/AppShell.tsx");

  assert.match(appShell, /const bootstrapHandoffNavigationDoneRef = useRef\(false\)/u);
  assert.match(appShell, /if \(bootstrapHandoffNavigationDoneRef\.current\) \{\s*return;/u);
  assert.match(appShell, /bootstrapHandoffNavigationDoneRef\.current = true;[\s\S]*?navigate\(createAgentNewChatRoute\(defaultChatAgentKey\), \{ replace: true \}\)/u);
  assert.doesNotMatch(appShell, /window\.setInterval\([\s\S]*?refreshAssistantNavAgents\(\)[\s\S]*?2_000/u);
  assert.doesNotMatch(appShell, /visibleAssistantNavChatItems/u);
  assert.match(appShell, /assistantNavChatItems=\{assistantNavChatItems\}/u);
  assert.match(appShell, /navigate\(createAgentNewChatRoute\(defaultChatAgentKey\), \{ replace: true \}\)/u);
});
