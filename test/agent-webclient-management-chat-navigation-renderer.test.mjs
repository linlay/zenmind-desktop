import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const projectRoot = process.cwd();

test("agent webclient management restores switch the Desktop shell to the chat route", () => {
  const source = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "service-webview", "ServiceWebviewSurface.tsx"),
    "utf8",
  );
  const navigationHandler = source.match(
    /const syncNavigationRoute = \(event: Event\) => \{[\s\S]*?const handleDidNavigate =/u,
  )?.[0] ?? "";

  assert.match(
    source,
    /function isAgentWebclientManagementSurface[\s\S]*?serviceId === "agent-webclient" && surfaceId === createServiceSurfaceIdentity\("agent-webclient"\)\.surfaceId/u,
  );
  assert.match(
    navigationHandler,
    /isAgentWebclientManagementSurface\(service\?\.id, surfaceId\)[\s\S]*?resolveAgentWebclientDesktopChatRouteFromUrl\([\s\S]*?navigate\(nextChatRoute\);/u,
  );
  assert.match(
    navigationHandler,
    /isAgentWebclientChatSurface\(service\?\.id, surfaceId\)[\s\S]*?navigate\(nextChatRoute, \{ replace: true \}\);/u,
  );
});
