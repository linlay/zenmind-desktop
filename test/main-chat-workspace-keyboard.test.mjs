import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const projectRoot = process.cwd();

function readSource(...segments) {
  return fs.readFileSync(path.join(projectRoot, ...segments), "utf8");
}

test("workspace arrow requests are accepted only by the active committed Main Chat guest", () => {
  const surfaceSource = readSource(
    "src",
    "renderer",
    "service-webview",
    "ServiceWebviewSurface.tsx",
  );
  const handlerStart = surfaceSource.indexOf(
    "if (payload.type === AGENT_WEBCLIENT_WORKSPACE_ARROW_KEY_MESSAGE_TYPE)",
  );
  const handlerEnd = surfaceSource.indexOf(
    "handleServiceWebviewBridgeMessage(payload",
    handlerStart,
  );
  const handler = surfaceSource.slice(handlerStart, handlerEnd);

  assert.ok(handlerStart >= 0);
  assert.match(handler, /isAgentWebclientWorkspaceArrowKeyMessage\(payload\)/u);
  assert.match(handler, /!mainChatSurface/u);
  assert.match(handler, /!ownsActiveSurface/u);
  assert.match(handler, /!committed/u);
  assert.match(handler, /committed\.webContentsId !== currentWebContentsId/u);
  assert.match(handler, /committed\.desiredKey !== desiredMainChatKey/u);
  assert.match(handler, /onAgentWebclientWorkspaceArrowKey\?\.\(payload\.direction\)/u);
});

test("Main Chat left toggles navigation and right uses the canonical WorkPanel gate", () => {
  const appShellSource = readSource(
    "src",
    "renderer",
    "app-shell",
    "AppShell.tsx",
  );
  const handlerStart = appShellSource.indexOf(
    "const handleMainChatWorkspaceArrowKey",
  );
  const handlerEnd = appShellSource.indexOf(
    "const openChatWorkPanelFromSidebar",
    handlerStart,
  );
  const handler = appShellSource.slice(handlerStart, handlerEnd);

  assert.ok(handlerStart >= 0);
  assert.match(handler, /direction === "left"/u);
  assert.match(handler, /toggleSidebarCollapsed\(\)/u);
  assert.match(handler, /toggleMainChatWorkPanel\(\)/u);
  assert.match(
    appShellSource,
    /onMainChatWorkspaceArrowKey=\{handleMainChatWorkspaceArrowKey\}/u,
  );
});

test("only the dedicated Main Chat surface receives the workspace arrow callback", () => {
  const hostSource = readSource(
    "src",
    "renderer",
    "app-shell",
    "embedded-surfaces",
    "EmbeddedSurfaceHosts.tsx",
  );
  const callbackMatches = hostSource.match(
    /onAgentWebclientWorkspaceArrowKey=\{onMainChatWorkspaceArrowKey\}/gu,
  ) ?? [];

  assert.equal(callbackMatches.length, 1);
  assert.match(
    hostSource,
    /surfaceIdentity=\{createSurfaceIdentity\("main-chat"/u,
  );
});
