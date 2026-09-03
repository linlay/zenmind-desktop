import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");

function readSource(...segments) {
  return fs.readFileSync(path.join(projectRoot, ...segments), "utf8");
}

function readButtonByClass(source, className) {
  const marker = `className="${className}"`;
  const markerIndex = source.indexOf(marker);
  assert.notEqual(markerIndex, -1, `missing button class: ${className}`);
  const startIndex = source.lastIndexOf("<button", markerIndex);
  const endIndex = source.indexOf("</button>", markerIndex);
  assert.notEqual(startIndex, -1, `missing button start: ${className}`);
  assert.notEqual(endIndex, -1, `missing button end: ${className}`);
  return source.slice(startIndex, endIndex + "</button>".length);
}

test("Projects reorder bridge is limited and wired across contract, preload, and Main", () => {
  const copilotContracts = readSource("src", "shared", "contracts", "copilot.ts");
  const desktopApi = readSource("src", "shared", "contracts", "desktop-api.ts");
  const preload = readSource("src", "preload", "index.ts");
  const handlers = readSource("src", "main", "ipc", "assistant-handlers.ts");

  assert.match(copilotContracts, /interface AssistantReorderProjectsRequest[\s\S]*?agentKeys: string\[\]/u);
  assert.match(copilotContracts, /interface AssistantReorderProjectsResult[\s\S]*?agentKeys: string\[\][\s\S]*?updatedAt\?: EpochMilliseconds/u);
  assert.match(desktopApi, /reorderProjects: \(input: AssistantReorderProjectsRequest\) => Promise<AssistantReorderProjectsResult>/u);
  assert.match(preload, /reorderProjects: \(input: AssistantReorderProjectsRequest\) =>[\s\S]{0,100}ipcRenderer\.invoke\("assistant\.reorderProjects", input\)/u);
  assert.match(handlers, /ipcMain\.handle\("assistant\.reorderProjects"/u);
  assert.match(handlers, /"\/api\/agents\?scope=nav&mode=CODER&mode=KBASE"/u);
  assert.match(handlers, /"\/api\/agents\/order"[\s\S]{0,100}method: "PUT"/u);
  assert.doesNotMatch(handlers, /"\/api\/admin\/agents"/u);
  assert.doesNotMatch(handlers, /"\/api\/admin\/agents\/order"/u);
  assert.doesNotMatch(preload, /agentPlatform:\s*\{/u);
});

test("expanded Projects use direct pointer and keyboard sorting", () => {
  const sidebar = readSource(
    "src",
    "renderer",
    "app-shell",
    "navigation",
    "AppSidebar.tsx",
  );
  const styles = readSource("src", "renderer", "styles", "navigation.css");
  const assistantNavigation = readSource(
    "src",
    "renderer",
    "assistantNavigation.ts",
  );
  const collapse = readSource(
    "src",
    "renderer",
    "components",
    "Collapse",
    "index.tsx",
  );

  assert.match(sidebar, /useSensor\(PointerSensor, \{ activationConstraint: \{ distance: 6 \} \}\)/u);
  assert.match(sidebar, /useSensor\(KeyboardSensor, \{ coordinateGetter: sortableKeyboardCoordinates \}\)/u);
  assert.match(sidebar, /renderItem\(\{[\s\S]*?attributes: sortable\.attributes,[\s\S]*?listeners: sortable\.listeners,[\s\S]*?setNodeRef: sortable\.setNodeRef,[\s\S]*?setActivatorNodeRef: sortable\.setActivatorNodeRef/u);
  assert.match(sidebar, /headerButtonRef=\{\(element\) => \{[\s\S]*?dragActivator\?\.setNodeRef\(element\);[\s\S]*?dragActivator\?\.setActivatorNodeRef\(element\);[\s\S]*?\.\.\.dragActivator\?\.listeners/u);
  assert.match(sidebar, /droppable: \{ strategy: MeasuringStrategy\.Always \}/u);
  assert.doesNotMatch(sidebar, /<div\s+ref=\{sortable\.setNodeRef\}[\s\S]{0,300}sidebar-sortable-project/u);
  assert.doesNotMatch(sidebar, /sidebar-project-drag-handle/u);
  assert.doesNotMatch(sidebar, /CSS\.Transform/u);
  assert.match(sidebar, /<DragOverlay[\s\S]*?sidebar-project-drag-overlay[\s\S]*?activeProjectDragItem\.displayName[\s\S]*?document\.body/u);
  assert.match(sidebar, /function resolveProjectDropIndicator[\s\S]*?position: activeIndex > overIndex \? "before" : "after"/u);
  assert.match(sidebar, /function handleProjectDragOver[\s\S]*?setProjectDropIndicator/u);
  assert.match(sidebar, /onDragOver=\{handleProjectDragOver\}/u);
  assert.match(sidebar, /projectDropIndicator\?\.agentKey === agent\.agentKey[\s\S]*?projectDropIndicator\.position/u);
  assert.match(sidebar, /expandedProjectsBeforeDragRef\.current = new Set\(expandedAssistantAgentKeys\);[\s\S]*?setExpandedAssistantAgentKeys\(new Set\(\)\)/u);
  assert.match(sidebar, /function finishProjectDrag\(\)[\s\S]*?setExpandedAssistantAgentKeys\(expandedProjectKeys\)/u);
  assert.match(sidebar, /onDragCancel=\{finishProjectDrag\}/u);
  assert.match(sidebar, /async function handleProjectDragEnd[\s\S]*?finishProjectDrag\(\)/u);
  assert.match(sidebar, /nextAgentKeys\.splice\([\s\S]*?dropIndicator\.position === "before" \? targetIndex : targetIndex \+ 1/u);
  assert.match(sidebar, /expanded=\{expandedAssistantAgentKeys\.has\(agent\.agentKey\)\}/u);
  assert.match(collapse, /const resolvedExpanded = expanded \?\? innerExpanded;/u);
  assert.match(sidebar, /activeKey === overKey[\s\S]{0,40}return null;/u);
  assert.match(sidebar, /setProjectOrderSaving\(true\)[\s\S]*?onReorderAssistantProjects\(\{[\s\S]*?agentKeys: nextAgentKeys,[\s\S]*?\}\)[\s\S]*?setProjectOrderSaving\(false\)/u);
  assert.match(sidebar, /isCollapsed \? \([\s\S]*?primaryAssistantNavAgents\.map\(\(agent\) =>[\s\S]*?renderAssistantAgent\(agent, \{ roving: false \}\)/u);
  assert.match(styles, /\.sidebar-sortable-project \.assistant-worker-header\s*\{[\s\S]*?app-region: no-drag;[\s\S]*?-webkit-app-region: no-drag;[\s\S]*?touch-action: none;/u);
  assert.match(styles, /\.sidebar-sortable-project\.has-drop-indicator-before::before,[\s\S]*?\.sidebar-sortable-project\.has-drop-indicator-after::after[\s\S]*?height: 2px;[\s\S]*?background: var\(--accent\)/u);
  assert.match(styles, /\.sidebar-project-drag-overlay\s*\{[\s\S]*?min-height:\s*36px;[\s\S]*?font-size:\s*14px;/u);
  assert.match(sidebar, /const allProjectsExpanded =[\s\S]*?primaryAssistantNavAgents\.every\(\(agent\) =>[\s\S]*?expandedAssistantAgentKeys\.has\(agent\.agentKey\)/u);
  assert.match(sidebar, /function handleToggleAllProjects[\s\S]*?setAssistantAgentChatVisibleLimits[\s\S]*?new Map<string, number>\(\)[\s\S]*?allProjectsExpanded[\s\S]*?new Set\([\s\S]*?primaryAssistantNavAgents\.map\(\(agent\) => agent\.agentKey\)/u);
  assert.match(sidebar, /sidebar-assistant-expand-button[\s\S]*?kind=\{allProjectsExpanded \? "collapse_all" : "expand_all"\}/u);
  assert.match(sidebar, /const PROJECT_CHATS_VISIBLE_LIMIT = 5;/u);
  assert.match(sidebar, /const recentChats = getAssistantNavAgentPreviewChats\(\s*agent,\s*projectChatVisibleLimit,\s*\);/u);
  assert.match(assistantNavigation, /getAssistantNavAgentPreviewChats\([\s\S]*?limit = 5,/u);
  assert.doesNotMatch(sidebar, /SIDEBAR_ASSISTANT_SORT_STORAGE_KEY|AssistantNavSortMode|sortAssistantNavAgentsForMode/u);
});

test("Project header hides nested actions with the outer group and uses one tooltip", () => {
  const sidebar = readSource(
    "src",
    "renderer",
    "app-shell",
    "navigation",
    "AppSidebar.tsx",
  );
  const conditionalActionsStart = sidebar.indexOf(
    '{args.groupId === "assistants" && expanded ? (',
  );
  const newProjectActionStart = sidebar.indexOf(
    '{args.groupId === "assistants" ? (',
    conditionalActionsStart + 1,
  );
  assert.notEqual(conditionalActionsStart, -1);
  assert.notEqual(newProjectActionStart, -1);

  const conditionalActions = sidebar.slice(
    conditionalActionsStart,
    newProjectActionStart,
  );
  assert.match(conditionalActions, /sidebar-assistant-expand-button/u);
  assert.match(conditionalActions, /sidebar-assistant-refresh-button/u);
  assert.doesNotMatch(conditionalActions, /sidebar-assistant-project-button/u);

  const assistantsCollapseEffect = sidebar.match(
    /useEffect\(\(\) => \{\s*if \(sidebarGroupState\.assistants\)[\s\S]*?\}, \[sidebarGroupState\.assistants\]\);/u,
  )?.[0] ?? "";
  assert.match(
    assistantsCollapseEffect,
    /setAssistantAgentChatVisibleLimits/u,
  );
  assert.doesNotMatch(
    assistantsCollapseEffect,
    /setExpandedAssistantAgentKeys/u,
  );

  for (const className of [
    "assistant-worker-icon-button sidebar-assistant-expand-button",
    "assistant-worker-icon-button sidebar-assistant-refresh-button",
    "assistant-worker-icon-button sidebar-assistant-project-button",
  ]) {
    const button = readButtonByClass(sidebar, className);
    assert.match(button, /aria-label=/u);
    assert.doesNotMatch(button, /\btitle=/u);
  }
});

test("AppShell optimistically applies, canonicalizes, and rolls back Project order", () => {
  const appShell = readSource(
    "src",
    "renderer",
    "app-shell",
    "AppShell.tsx",
  );

  assert.match(appShell, /setAssistantNavAgents\(\(current\) =>\s*reorderAssistantNavProjectAgents\(current, input\.agentKeys\)/u);
  assert.match(appShell, /window\.electronAPI\.assistant\.reorderProjects\(input\)/u);
  assert.match(appShell, /if \(!result\.ok\)[\s\S]*?previousProjectAgentKeys[\s\S]*?refreshAssistantNavAgents\(\{ force: true \}\)/u);
  assert.match(appShell, /reorderAssistantNavProjectAgents\(current, result\.agentKeys\)[\s\S]*?refreshAssistantNavAgents\(\{ force: true \}\)/u);
});
