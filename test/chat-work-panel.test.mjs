import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const read = (relativePath) => fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");

test("WorkPanel is AppShell-owned and keeps heterogeneous items mounted", () => {
  const embeddedHosts = read("src/renderer/app-shell/embedded-surfaces/EmbeddedSurfaceHosts.tsx");
  const appShell = read("src/renderer/app-shell/AppShell.tsx");
  const host = read("src/renderer/work-panel/WorkPanelHost.tsx");
  const reducer = read("src/shared/work-panel.ts");
  const css = read("src/renderer/styles/app-shell.css");

  assert.match(embeddedHosts, /AGENT_WEBCLIENT_CHAT_SURFACE_ID = "agent-webclient-chat"/u);
  assert.match(appShell, /useState<WorkPanelState>\(EMPTY_WORK_PANEL_STATE\)/u);
  assert.match(appShell, /reduceWorkPanelCommand\(workPanelStateRef\.current, command\)/u);
  assert.match(appShell, /<WorkPanelHost/u);
  assert.match(host, /state\.workspaces\.map/u);
  assert.match(host, /workspace\.items\.map/u);
  assert.match(host, /item\.descriptor\.kind === "webclient"/u);
  assert.match(host, /item\.descriptor\.kind !== "web"/u);
  assert.match(host, /<ServiceWebviewSurface/u);
  assert.match(host, /<ExternalWebviewPage/u);
  assert.match(host, /hidden=\{!visible\}/u);
  assert.match(reducer, /stableKey:\s*`web:\$\{url\}`/u);
  assert.match(read("src/renderer/service-webview/ServiceWebviewSurface.tsx"), /\/overview\/iu/u);
  assert.doesNotMatch(read("src/renderer/service-webview/ServiceWebviewSurface.tsx"), /\/summary\/iu/u);
  assert.match(css, /\.work-panel-host\s*\{[^}]*display:\s*contents;/su);
});

test("WorkPanel actions derive ownership from trusted source and preserve a stateless legacy adapter", () => {
  const actions = read("src/shared/desktop-actions.ts");
  const host = read("src/renderer/work-panel/WorkPanelHost.tsx");
  const reducer = read("src/shared/work-panel.ts");
  const bridge = read("src/main/desktop-action-bridge.ts");

  for (const name of ["getState", "openItem", "activateItem", "closeItem", "closeWorkspace"]) {
    assert.match(actions, new RegExp(`desktop\\.workpanel\\.${name}`, "u"));
  }
  for (const name of ["getState", "open", "close", "openTab", "activateTab", "closeTab"]) {
    assert.match(actions, new RegExp(`desktop\\.chatWorkPanel\\.${name}`, "u"));
  }
  assert.match(host, /request\.source\?\.chatId/u);
  assert.match(host, /desktop\.chatWorkPanel\.openTab/u);
  assert.match(host, /descriptor:\s*\{ kind: "web", url/u);
  assert.match(reducer, /legacyActionCount/u);
  assert.match(bridge, /request\.source\?\.chatId/u);
  assert.doesNotMatch(host, /new Map<string, ChatWorkPanelWorkspace>/u);
});

test("WorkPanel enforces one ephemeral Web guest per item and explicit platform focus branches", () => {
  const host = read("src/renderer/work-panel/WorkPanelHost.tsx");
  const reducer = read("src/shared/work-panel.ts");

  assert.match(host, /itemPartition\(workspace\.workspaceId, item\.itemId\)/u);
  assert.match(host, /clearSession\?\.\(\{ partition \}\)/u);
  assert.match(host, /allowUserTabCreation=\{false\}/u);
  assert.match(host, /openPopupsInCurrentTab/u);
  assert.match(host, /if \(isMac\)/u);
  assert.match(host, /else if \(isWindows\)/u);
  assert.match(host, /dataset\.workPanelDomReady === "true"/u);
  assert.match(reducer, /unsupported_native_surface/u);
  assert.match(reducer, /item\.pinned \|\| !item\.closable/u);
});
