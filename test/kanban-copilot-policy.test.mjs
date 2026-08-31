import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");

test("Kanban hard-disables every Copilot Dock entry while leaving Kanban Chat intact", () => {
  const appShell = read("src", "renderer", "app-shell", "AppShell.tsx");
  assert.match(appShell, /const copilotDockAllowed = !isKanbanRoute && !isAgentWebclientMainRoute/u);
  assert.match(appShell, /assistantLauncherVisible = copilotDockAllowed/u);
  assert.match(appShell, /if \(!copilotDockAllowed\) \{/u);
  assert.match(appShell, /const forbiddenContextKey = "desktop-route:\/kanban"/u);
  assert.match(appShell, /delete nextSessions\[forbiddenContextKey\]/u);
});

test("Copilot Dock registration carries route context for the main-process Kanban guard", () => {
  const dock = read("src", "renderer", "copilot", "sidebar-copilot", "AgentWebclientCopilotDock.tsx");
  assert.match(dock, /contextKey: string/u);
  assert.match(dock, /surfaceIdentityKey=\{contextKey\}/u);
});
