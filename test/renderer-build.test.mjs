import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const projectRoot = process.cwd();

test("renderer entry uses HashRouter for Electron routing", () => {
  const rendererEntry = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "main.tsx"),
    "utf8"
  );

  assert.match(rendererEntry, /HashRouter/);
  assert.doesNotMatch(rendererEntry, /BrowserRouter/);
});

test("sidebar does not expose the built-in Chrome surface", () => {
  const sidebarSource = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "components", "AppSidebar.tsx"),
    "utf8"
  );

  assert.doesNotMatch(sidebarSource, /browserNavItem/);
  assert.doesNotMatch(sidebarSource, /BUILTIN_BROWSER_ROUTE/);
});

test("built index uses relative asset paths", () => {
  const builtIndex = fs.readFileSync(path.join(projectRoot, "dist-renderer", "index.html"), "utf8");

  assert.doesNotMatch(builtIndex, /src="\/assets\//);
  assert.doesNotMatch(builtIndex, /href="\/assets\//);
  assert.match(builtIndex, /(src|href)="\.?\/?assets\//);
});

test("plugin market guards stale preload market api before skill import", () => {
  const marketPage = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "pages", "PluginMarketPage.tsx"),
    "utf8"
  );

  assert.match(marketPage, /function getMarketApi\(/);
  assert.match(marketPage, /function getPluginApi\(/);
  assert.match(marketPage, /MARKET_API_UNAVAILABLE_MESSAGE/);
  assert.match(marketPage, /PLUGIN_API_UNAVAILABLE_MESSAGE/);
  assert.doesNotMatch(marketPage, /window\.electronAPI\.market\.importSkill\(\)/);
  assert.doesNotMatch(marketPage, /installPlugin\(\)/);
});

test("market route disables the global drag overlay above toolbar controls", () => {
  const appShell = fs.readFileSync(path.join(projectRoot, "src", "renderer", "App.tsx"), "utf8");
  const globalStyles = fs.readFileSync(path.join(projectRoot, "src", "renderer", "styles.css"), "utf8");
  const marketStyles = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "pages", "PluginMarketPage.css"),
    "utf8"
  );

  assert.match(appShell, /has-market-controls/);
  assert.match(globalStyles, /\.app-shell\.has-market-controls\s+\.app-window-drag-region/);
  assert.match(marketStyles, /-webkit-app-region:\s*no-drag;/);
});

test("external webview tabs use repeatable pointer reordering", () => {
  const externalWebviewPage = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "pages", "ExternalWebviewPage.tsx"),
    "utf8"
  );

  assert.match(externalWebviewPage, /tabPointerDragRef/);
  assert.match(externalWebviewPage, /tabPointerCleanupRef/);
  assert.match(externalWebviewPage, /handleTabPointerMove/);
  assert.match(externalWebviewPage, /document\.addEventListener\("pointermove"/);
  assert.match(externalWebviewPage, /setTabDragOffsetX/);
  assert.match(externalWebviewPage, /moveItemByIdToIndex\(\s*currentState\.tabs/);
  assert.match(externalWebviewPage, /onPointerMove=\{handleTabPointerMove\}/);
  assert.match(externalWebviewPage, /onPointerDown=\{\(event\) => handleTabPointerDown\(event, tab\.id\)\}/);
  assert.doesNotMatch(externalWebviewPage, /onDragStart=\{\(event\) => handleTabDragStart\(event, tab\.id\)\}/);
});

test("external webview bookmarks use document-level pointer reordering", () => {
  const externalWebviewPage = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "pages", "ExternalWebviewPage.tsx"),
    "utf8"
  );

  assert.match(externalWebviewPage, /bookmarkPointerCleanupRef/);
  assert.match(externalWebviewPage, /updateBookmarkPointerDrag/);
  assert.match(externalWebviewPage, /document\.addEventListener\("pointermove", handleDocumentPointerMove/);
  assert.match(externalWebviewPage, /moveItemByIdToIndex\(\s*currentBookmarks/);
  assert.match(externalWebviewPage, /onPointerDown=\{\(event\) => handleBookmarkPointerDown\(event, bookmark\.id\)\}/);
});

test("assistant artifact outputs render in a XiaoZhai-style dock above the composer", () => {
  const assistantDock = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "components", "AssistantDock.tsx"),
    "utf8"
  );
  const quickAssistant = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "components", "QuickAssistant.tsx"),
    "utf8"
  );
  const globalStyles = fs.readFileSync(path.join(projectRoot, "src", "renderer", "styles.css"), "utf8");

  assert.match(assistantDock, /renderArtifactDock/);
  assert.match(assistantDock, /assistant-artifact-dock/);
  assert.match(assistantDock, /assistant-artifact-list/);
  assert.match(assistantDock, /assistant-artifact-item/);
  assert.match(assistantDock, /assistant-artifact-collapse/);
  assert.match(quickAssistant, /quick-artifact-dock/);
  assert.doesNotMatch(assistantDock, /assistant-message-artifact-card/);
  assert.doesNotMatch(quickAssistant, /quick-message-artifact-card/);
  assert.match(globalStyles, /\.assistant-artifact-dock/);
  assert.match(globalStyles, /\.assistant-artifact-card-file-shell/);
  assert.match(globalStyles, /\.quick-artifact-dock/);
});

test("assistant chat history uses a searchable popover list", () => {
  const assistantDock = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "components", "AssistantDock.tsx"),
    "utf8"
  );
  const globalStyles = fs.readFileSync(path.join(projectRoot, "src", "renderer", "styles.css"), "utf8");

  assert.match(assistantDock, /assistant-history-popover/);
  assert.match(assistantDock, /placeholder="搜索历史记录"/);
  assert.match(assistantDock, /assistant-history-row-main/);
  assert.match(assistantDock, /handleDeleteChat\(chat\.id\)/);
  assert.match(globalStyles, /\.assistant-history-popover/);
  assert.match(globalStyles, /\.assistant-history-avatar/);
  assert.match(globalStyles, /\.assistant-history-row-delete/);
  assert.doesNotMatch(assistantDock, /assistant-dock-chat-delete/);
});

test("assistant compact dock yields to native dialogs and closes from outside clicks", () => {
  const appShell = fs.readFileSync(path.join(projectRoot, "src", "renderer", "App.tsx"), "utf8");
  const assistantDock = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "components", "AssistantDock.tsx"),
    "utf8"
  );
  const preload = fs.readFileSync(path.join(projectRoot, "src", "preload", "index.ts"), "utf8");
  const mainProcess = fs.readFileSync(path.join(projectRoot, "src", "main", "index.ts"), "utf8");
  const globalStyles = fs.readFileSync(path.join(projectRoot, "src", "renderer", "styles.css"), "utf8");
  const quickAssistantBlurHandler = mainProcess.slice(
    mainProcess.indexOf('quickAssistantWindow.on("blur"'),
    mainProcess.indexOf('quickAssistantWindow.on("closed"')
  );

  assert.match(mainProcess, /app\.nativeDialogVisibility/);
  assert.match(mainProcess, /process\.platform === "darwin"/);
  assert.match(mainProcess, /hideQuickAssistantForNativeDialog/);
  assert.match(mainProcess, /restoreQuickAssistantAfterNativeDialog/);
  assert.match(mainProcess, /hideQuickAssistantAfterOutsideFocus/);
  assert.match(mainProcess, /app\.on\("activate"[\s\S]{0,120}nativeDialogVisibilityDepth > 0[\s\S]{0,80}return;/);
  assert.match(mainProcess, /quickAssistantDismissWindow/);
  assert.match(mainProcess, /QUICK_ASSISTANT_DISMISS_URL/);
  assert.match(mainProcess, /showQuickAssistantDismissWindow/);
  assert.doesNotMatch(quickAssistantBlurHandler, /mouseInside/);
  assert.match(preload, /onNativeDialogVisibility/);
  assert.match(appShell, /nativeDialogVisible/);
  assert.match(assistantDock, /nativeDialogVisible/);
  assert.match(assistantDock, /attachmentPickerVisible/);
  assert.match(assistantDock, /nativeDialogVisible && !attachmentPickerVisible/);
  assert.match(assistantDock, /assistant-dock-outside-dismiss/);
  assert.match(assistantDock, /shouldRenderCompactDismissLayer/);
  assert.match(globalStyles, /\.assistant-dock-root\.is-open\.is-native-dialog-open/);
  assert.match(globalStyles, /\.assistant-dock-outside-dismiss/);
});

test("plugin page provides iframe-aware assistant context instead of guessing embedded content", () => {
  const pluginPage = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "pages", "PluginPage.tsx"),
    "utf8"
  );

  assert.match(pluginPage, /registerAssistantPageContextProvider/);
  assert.match(pluginPage, /tryReadPluginIframePageContext/);
  assert.match(pluginPage, /buildPluginIframeFallbackContext/);
  assert.match(pluginPage, /无法直接读取这个 iframe 内部的列表、卡片或正文文本/);
  assert.match(pluginPage, /不要猜测网站、应用名称或列表项/);
});

test("native assistant page context captures shell sidebar, left region, and modal content separately", () => {
  const pageContextService = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "services", "assistantPageContext.ts"),
    "utf8"
  );

  assert.match(pageContextService, /shellSidebarText/);
  assert.match(pageContextService, /leftRegionText/);
  assert.match(pageContextService, /modalText/);
  assert.match(pageContextService, /\.service-sider/);
  assert.match(pageContextService, /\.help-sidebar/);
  assert.match(pageContextService, /\.log-viewer-modal/);
  assert.match(pageContextService, /\[hidden\]/);
  assert.match(pageContextService, /\[aria-hidden="true"\]/);
  assert.match(pageContextService, /iframe/);
  assert.match(pageContextService, /webview/);
});

test("assistant dock opens in right-side embedded mode by default", () => {
  const appShell = fs.readFileSync(path.join(projectRoot, "src", "renderer", "App.tsx"), "utf8");

  assert.match(appShell, /openAssistantDock\("full"\);/);
  assert.doesNotMatch(appShell, /onOpen=\{\(\) => openAssistantDock\("compact"\)\}/);
  assert.doesNotMatch(appShell, /onOpenAssistantWorker[\s\S]{0,180}openAssistantDock\("compact"\)/);
});

test("quick assistant popup keeps ask and voice recovery controls visible", () => {
  const quickAssistant = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "components", "QuickAssistant.tsx"),
    "utf8"
  );
  const globalStyles = fs.readFileSync(path.join(projectRoot, "src", "renderer", "styles.css"), "utf8");

  assert.match(quickAssistant, /function handleStopRun/);
  assert.match(quickAssistant, /voiceOperationIdRef/);
  assert.match(quickAssistant, /withVoiceTimeout/);
  assert.match(quickAssistant, /const hasDraft = draft\.trim\(\)\.length > 0/);
  assert.match(quickAssistant, /const singleLineComposer = !voiceExpandedComposer && !currentComposerHasStatus/);
  assert.match(quickAssistant, /const maxHeight = hasDraft && \(isExpanded \|\| voiceExpandedComposer\) \? 160 : singleLineComposer \? 42 : 46/);
  assert.match(quickAssistant, /aria-live="polite"/);
  assert.match(quickAssistant, /<StopIcon \/>/);
  assert.doesNotMatch(quickAssistant, /voiceState === "transcribing"[\s\S]{0,260}new MediaRecorder/);
  assert.match(globalStyles, /\.quick-composer-status/);
  assert.match(globalStyles, /\.quick-assistant\.is-compact\s+\.quick-send-button/);
});

test("quick assistant attachment entry stays compact and independent from the main assistant", () => {
  const quickAssistant = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "components", "QuickAssistant.tsx"),
    "utf8"
  );
  const assistantDock = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "components", "AssistantDock.tsx"),
    "utf8"
  );
  const globalStyles = fs.readFileSync(path.join(projectRoot, "src", "renderer", "styles.css"), "utf8");
  const appendAttachmentResult = quickAssistant.slice(
    quickAssistant.indexOf("async function appendAttachmentResult"),
    quickAssistant.indexOf("async function chooseAttachmentFiles")
  );

  assert.match(quickAssistant, /quickAssistantDisplayMode/);
  assert.match(quickAssistant, /quickAssistant\.setDisplayMode/);
  assert.match(quickAssistant, /quickAssistant\.pickAttachments/);
  assert.match(quickAssistant, /hiddenArtifactIds/);
  assert.match(quickAssistant, /visibleAttachments/);
  assert.match(quickAssistant, /quick-attachment-preview-card/);
  assert.match(quickAssistant, /function removeAttachment/);
  assert.match(quickAssistant, /quick-attachment-remove/);
  assert.match(quickAssistant, /quick-artifact-remove/);
  assert.match(assistantDock, /hiddenArtifactIds/);
  assert.match(assistantDock, /assistant-artifact-remove/);
  assert.doesNotMatch(quickAssistant, /quick-mode-pill/);
  assert.match(quickAssistant, /chooseAttachmentFiles/);
  assert.match(quickAssistant, /const showSendAction = hasDraft \|\| attachments\.some/);
  assert.match(quickAssistant, /quick-primary-action/);
  assert.match(quickAssistant, /quick-expand-button/);
  assert.match(quickAssistant, /const composerStatus = isExpanded \?/);
  assert.doesNotMatch(quickAssistant, /attachmentMenuOpen/);
  assert.doesNotMatch(quickAssistant, /quick-attachment-menu/);
  assert.doesNotMatch(quickAssistant, /window\.electronAPI\.assistant\.pickAttachments\(activeChatId\)/);
  assert.doesNotMatch(appendAttachmentResult, /setIsExpanded\(true\)/);
  assert.match(globalStyles, /grid-template-columns:\s*42px minmax\(0, 1fr\) 42px 46px/);
  assert.match(globalStyles, /\.quick-assistant\.is-compact\.has-attachments/);
  assert.match(globalStyles, /\.quick-attachment-preview-card/);
  assert.match(globalStyles, /\.quick-attachment-remove/);
  assert.match(globalStyles, /\.quick-artifact-remove/);
  assert.match(globalStyles, /\.assistant-artifact-remove/);
  assert.match(globalStyles, /\.assistant-dock-attachment-chip button/);
  assert.doesNotMatch(globalStyles, /\.quick-mode-pill/);
  assert.match(globalStyles, /font-size:\s*18px/);
  assert.doesNotMatch(globalStyles, /\.quick-attachment-menu/);
  assert.match(globalStyles, /\.quick-composer\.has-status/);
});
