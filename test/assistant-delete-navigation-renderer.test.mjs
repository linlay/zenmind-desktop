import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const projectRoot = process.cwd();

test("deleting the active sidebar chat navigates away from its stale route", () => {
  const source = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "app-shell", "navigation", "AppSidebar.tsx"),
    "utf8",
  );
  const handler = source.match(
    /async function handleConfirmDeleteChat[\s\S]*?function handleAssistantDockClick/u,
  )?.[0] ?? "";

  assert.match(handler, /const chat = assistantChatDeleteDialog\.chat/u);
  assert.match(handler, /const result = await window\.electronAPI\.assistant\.deleteChat\(\s*chat\.chatId/u);
  assert.match(handler, /if \(!result\.ok\)/u);
  assert.match(handler, /currentChatId === chat\.chatId/u);
  assert.match(handler, /candidate\.chatId !== chat\.chatId/u);
  assert.match(handler, /createAgentChatRoute\(agentKey, nextChat\.chatId\)/u);
  assert.match(handler, /createAgentRoute\(agentKey\)/u);
  assert.match(handler, /onRequestNavigate\?\.\(nextRoute\)/u);

  const navigateIndex = handler.indexOf("onRequestNavigate?.(nextRoute)");
  const refreshIndex = handler.indexOf("await onRefreshAssistantNavAgents?.()");
  assert.ok(navigateIndex >= 0 && navigateIndex < refreshIndex);
});
