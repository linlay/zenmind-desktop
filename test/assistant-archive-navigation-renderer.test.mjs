import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const projectRoot = process.cwd();

test("archiving the active sidebar chat navigates away from its stale route", () => {
  const source = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "app-shell", "navigation", "AppSidebar.tsx"),
    "utf8",
  );
  const handler = source.match(
    /async function handleAssistantArchiveChat[\s\S]*?async function handleAssistantDeleteChat/u,
  )?.[0] ?? "";

  assert.match(handler, /const result = await window\.electronAPI\.assistant\.archiveChat\(chat\.chatId\)/u);
  assert.match(handler, /if \(!result\?\.ok\)/u);
  assert.match(handler, /window\.alert\(result\?\.message \|\| t\("sidebar\.chat\.archiveFailed"\)\)/u);
  assert.match(handler, /currentChatId === chat\.chatId/u);
  assert.match(handler, /candidate\.chatId !== chat\.chatId/u);
  assert.match(handler, /onRequestNavigate\?\.\(nextRoute\)/u);
  assert.match(handler, /await onRefreshAssistantNavAgents\?\.\(\)/u);
});
