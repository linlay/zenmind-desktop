import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

test("Agent WebClient guest token injection is removed", () => {
  assert.equal(fs.existsSync(path.join(root, "src/shared/agent-webclient-auth-injection.ts")), false);
  const surface = read("src/renderer/service-webview/ServiceWebviewSurface.tsx");
  const mainWorld = read("src/preload/service-webview-main-world.ts");
  const hostBridge = read("src/renderer/services/serviceWebviewBridgeHost.ts");
  assert.doesNotMatch(surface, /seedAgentWebclientAccessToken|buildAgentWebclientAccessTokenInjectionScript/u);
  assert.match(mainWorld, /removeItem\(AGENT_APP_ACCESS_TOKEN_STORAGE_KEY\)/u);
  assert.match(hostBridge, /context\.serviceId === "agent-webclient"[\s\S]{0,260}token:\s*null/u);
});

test("Desktop host injects HTTP auth and hard-blocks legacy realtime bypasses", () => {
  const host = read("src/main/services/agent-webclient-host.ts");
  assert.match(host, /authorization/u);
  assert.match(host, /desktop_realtime_bridge_required/u);
  assert.match(host, /DESKTOP_BRIDGE_ONLY_HTTP_PATHS/u);
  assert.match(host, /requestPath\.startsWith\("\/api\/voice"\)/u);
});
