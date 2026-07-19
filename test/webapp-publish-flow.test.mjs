import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function read(relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath), "utf8");
}

test("XiaoJun WebApp actions install, publish, and unpublish through the public Desktop bridge", () => {
  const catalog = read("src/shared/desktop-actions.ts");
  const bridge = read("src/main/desktop-action-bridge.ts");
  const wsServer = read("src/main/desktop-ws-server.ts");
  const wsContract = read("src/shared/desktop-ws.ts");

  for (const action of [
    "desktop.web.webapp.installAndOpen",
    "desktop.web.webapp.getPublishInfo",
    "desktop.web.webapp.publish",
    "desktop.web.webapp.unpublish"
  ]) {
    assert.match(catalog, new RegExp(action.replaceAll(".", "\\."), "u"));
    assert.match(bridge, new RegExp(action.replaceAll(".", "\\."), "u"));
  }
  assert.doesNotMatch(catalog, /desktop\.web\.webapps\.installAndOpen/u);
  assert.match(bridge, /notifyWebsChanged\(options\);[\s\S]*?webappRuntime\.start\(options\.app, webappId\)[\s\S]*?options\.navigate\(route\)/u);
  assert.match(bridge, /webapp_install_not_visible/u);
  assert.match(bridge, /hasTunnelWebappSubscriber\?\.\(\)[\s\S]*?publishWebapp\(options\.app, webappId, command\.state\)/u);
  assert.match(bridge, /mobilePublish[\s\S]*?attempted:\s*true/u);
  assert.match(bridge, /emitWebappChanged\?\.\(result\.ok \? "published" : "publish-failed", webappId\)/u);
  assert.match(wsContract, /"web\.webapp\.list"/u);
  assert.match(wsContract, /"webapp\.changed"/u);
  for (const alias of [
    "web.webapp.getPublishInfo",
    "web.webapp.publish",
    "web.webapp.unpublish"
  ]) {
    const pattern = new RegExp(alias.replaceAll(".", "\\."), "u");
    assert.match(wsServer, pattern);
    assert.match(wsContract, pattern);
  }
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
