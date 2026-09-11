import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (...segments) => fs.readFileSync(path.join(root, ...segments), "utf8");

test("selection explanation window is singleton, temporary and never always-on-top", () => {
  const controller = read("src", "main", "modules", "shell", "selection-explain-window.ts");
  assert.match(controller, /private window: BrowserWindow \| null = null/u);
  assert.match(controller, /if \(input\.status !== "pending" && this\.state\?\.requestId !== requestId\) return/u);
  assert.match(controller, /frame: false/u);
  assert.match(controller, /modal: false/u);
  assert.match(controller, /const anchorBounds = anchor && !anchor\.isDestroyed\(\)[\s\S]*?anchor\.getBounds\(\)/u);
  assert.match(controller, /screen\.getDisplayMatching\(anchorBounds\)/u);
  assert.match(controller, /anchorBounds\.x \+ anchorBounds\.width - windowBounds\.width - margin/u);
  assert.match(controller, /anchorBounds\.y \+ anchorBounds\.height - windowBounds\.height - margin/u);
  assert.match(controller, /screen\.getDisplayNearestPoint\(screen\.getCursorScreenPoint\(\)\)/u);
  assert.match(controller, /target\.setPosition\(position\.x, position\.y, false\)/u);
  assert.doesNotMatch(controller, /alwaysOnTop|setAlwaysOnTop|setVisibleOnAllWorkspaces/u);
  assert.match(controller, /this\.state = null/u);
});

test("selection explanation renderer hands only Chat and Run ids to the WebClient route", () => {
  const page = read("src", "renderer", "pages", "SelectionExplainWindowPage.tsx");
  const contract = read("src", "shared", "selection-explain-window.ts");
  assert.match(page, /\/selection-explain\/\$\{encodeURIComponent\(state\.chatId\)\}\?runId=/u);
  assert.match(page, /createSurfaceIdentity\("selection-explain"/u);
  assert.match(page, /ownerChatId: state\.chatId/u);
  assert.doesNotMatch(contract, /selectedText|\btext:\s*string|prompt/u);
});

test("selection explanation surface uses an isolated BTW root role", () => {
  const identities = read("src", "shared", "surface-identity.ts");
  const handler = ["ipc.shared.ts", "ipc.operations-3.ts"].map((filename) =>
    read("src", "main", "modules", "agent-platform", filename)
  ).join("\n");
  const broker = ["realtime-broker.ts", "realtime-broker.methods-1.ts"].map((filename) =>
    read("src", "main", "modules", "agent-platform", "realtime", filename)
  ).join("\n");
  assert.match(identities, /"selection-explain"/u);
  assert.match(handler, /return "selection_explain" as const/u);
  assert.match(handler, /context\.kind === "agent-selection-explain"/u);
  assert.match(broker, /auxiliaryRootObservers/u);
  assert.match(broker, /input\.kind === "selection_explain"/u);
});
