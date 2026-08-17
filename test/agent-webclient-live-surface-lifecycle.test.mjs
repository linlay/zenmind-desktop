import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts) => readFileSync(path.join(projectRoot, ...parts), "utf8");

test("all three Desktop live Chat surface kinds publish active lifecycle to their mounted guest", () => {
  const surface = read("src", "renderer", "service-webview", "ServiceWebviewSurface.tsx");
  for (const surfaceId of [
    "agent-webclient-chat",
    "agent-webclient-copilot",
    "agent-webclient-copilot-dock",
    "agent-webclient-kanban-chat",
  ]) {
    assert.match(surface, new RegExp(`['\"]${surfaceId}['\"]`));
  }
  assert.match(surface, /DESKTOP_SURFACE_ACTIVE_CHANGED_MESSAGE_TYPE/);
  assert.match(
    surface,
    /if \(!ownsActiveSurface\) \{[\s\S]*?sendLiveSurfaceLifecycleToWebview\(false\)[\s\S]*?registerSurface\(registration\)/,
  );
  assert.match(
    surface,
    /registerSurface\(registration\)\.then\(\(result\) => \{[\s\S]*?if \(result\.ok\) \{[\s\S]*?if \(ownsActiveSurface\) \{[\s\S]*?sendLiveSurfaceLifecycleToWebview\(true\)/,
  );
  assert.match(surface, /return \(\) => sendLiveSurfaceLifecycleToWebview\(false\)/);
});
