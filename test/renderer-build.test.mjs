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

test("assistant artifact outputs render in a ZenMind-style dock above the composer", () => {
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

test("sidebar and quick assistant share ZenMind identity and active-chat event recovery", () => {
  const assistantCapabilities = fs.readFileSync(
    path.join(projectRoot, "src", "shared", "assistant-capabilities.ts"),
    "utf8"
  );
  const assistantDock = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "components", "AssistantDock.tsx"),
    "utf8"
  );
  const quickAssistant = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "components", "QuickAssistant.tsx"),
    "utf8"
  );
  const assistantEventState = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "services", "assistantEventState.ts"),
    "utf8"
  );
  const assistantArtifacts = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "services", "assistantArtifacts.ts"),
    "utf8"
  );
  const mainProcess = fs.readFileSync(path.join(projectRoot, "src", "main", "index.ts"), "utf8");

  assert.match(assistantCapabilities, /ZENMIND_ASSISTANT_AGENT_KEY = "zenmind"/);
  assert.match(assistantCapabilities, /ZENMIND_ASSISTANT_NAME = "ZenMind"/);
  assert.match(assistantCapabilities, /侧边栏和快速助手中作为同一个本地单智能体/);
  assert.match(quickAssistant, /function ZenMindMarkIcon/);
  assert.match(quickAssistant, /placeholder="问问 ZenMind"/);
  assert.match(quickAssistant, /你可以直接问 ZenMind/);
  assert.match(assistantDock, /aria-label="ZenMind"/);
  assert.match(mainProcess, /displayName:\s*"ZenMind"/);
  assert.doesNotMatch(assistantCapabilities, /Zman|小宅|desktop-xiaozhai/);
  assert.doesNotMatch(assistantDock, /Zman|desktop-xiaozhai|ZenMind助手/);
  assert.doesNotMatch(quickAssistant, /Zman|ZmanMarkIcon|desktop-xiaozhai|ZenMind助手/);

  assert.match(assistantEventState, /function getLatestPendingAwaitingPayload/);
  assert.match(assistantEventState, /function attachRunningAssistantPlaceholder/);
  assert.match(assistantEventState, /function shouldEnsureAssistantMessageForEvent/);
  assert.match(assistantEventState, /ASSISTANT_RUN_EVENT_TYPES/);
  assert.match(assistantEventState, /function reduceAssistantTimelineEvent/);
  assert.doesNotMatch(assistantEventState, /tool\.verify|tool\.route|voice\.transcribed|voice\.corrected|voice\.needs_review|intent\.classified/);
  assert.match(assistantArtifacts, /function getArtifactAttachmentsFromEvent/);
  assert.match(assistantDock, /attachRunningAssistantPlaceholder/);
  assert.match(assistantDock, /event\.chatId === activeChatIdRef\.current/);
  assert.match(quickAssistant, /isStructuredAssistantEvent/);
  assert.match(quickAssistant, /quickAssistant\.openMainAssistant\(event\.chatId\)/);
  assert.doesNotMatch(assistantDock, /requestedChatId === activeChatIdRef\.current/);
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
  const preload = fs.readFileSync(path.join(projectRoot, "src", "preload", "index.ts"), "utf8");
  const mainProcess = fs.readFileSync(path.join(projectRoot, "src", "main", "index.ts"), "utf8");
  const quickAssistantWindow = fs.readFileSync(path.join(projectRoot, "src", "main", "quick-assistant.ts"), "utf8");

  assert.match(quickAssistant, /function handleStopRun/);
  assert.match(quickAssistant, /voiceOperationIdRef/);
  assert.match(quickAssistant, /withVoiceTimeout/);
  assert.match(quickAssistant, /const hasDraft = draft\.trim\(\)\.length > 0/);
  assert.match(quickAssistant, /const singleLineComposer = !voiceExpandedComposer && !currentComposerHasStatus/);
  assert.match(quickAssistant, /const maxHeight = hasDraft && \(isExpanded \|\| voiceExpandedComposer\) \? 160 : singleLineComposer \? 42 : 46/);
  assert.ok(
    quickAssistant.indexOf("const attachmentMenuDisabled =") <
      quickAssistant.indexOf("}, [attachmentMenuDisabled]);")
  );
  assert.match(quickAssistant, /aria-live="polite"/);
  assert.match(quickAssistant, /<StopIcon \/>/);
  assert.doesNotMatch(quickAssistant, /voiceState === "transcribing"[\s\S]{0,260}new MediaRecorder/);
  assert.match(globalStyles, /\.quick-composer-status/);
  assert.match(globalStyles, /\.quick-assistant\.is-compact\s+\.quick-send-button/);
  assert.match(quickAssistantWindow, /QUICK_ASSISTANT_COMPACT_MENU_SIZE/);
  assert.match(quickAssistantWindow, /QUICK_ASSISTANT_MENU_SIZE/);
  assert.match(quickAssistantWindow, /QuickAssistantDisplayMode = "compact" \| "attachment" \| "compactMenu" \| "menu" \| "expanded"/);
  assert.match(preload, /"compact" \| "attachment" \| "compactMenu" \| "menu" \| "expanded"/);
  assert.match(mainProcess, /devTools:\s*false/);
});

test("assistant voice UI no longer exposes a correction toggle and always follows the fixed correction flow", () => {
  const settingsPage = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "pages", "SettingsPage.tsx"),
    "utf8"
  );
  const quickAssistant = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "components", "QuickAssistant.tsx"),
    "utf8"
  );
  const assistantDock = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "components", "AssistantDock.tsx"),
    "utf8"
  );
  const assistantRuntime = fs.readFileSync(
    path.join(projectRoot, "src", "main", "assistant", "runtime.ts"),
    "utf8"
  );

  assert.doesNotMatch(settingsPage, /语音模型纠错/);
  assert.doesNotMatch(settingsPage, /handleToggleVoiceCorrection/);
  assert.doesNotMatch(settingsPage, /assistant\.getSettings\(\)/);
  assert.doesNotMatch(settingsPage, /assistant\.saveSettings\(/);
  assert.doesNotMatch(quickAssistant, /isVoiceCorrectionEnabled/);
  assert.doesNotMatch(quickAssistant, /!isVoiceCorrectionEnabled\(latestSettings\)/);
  assert.match(quickAssistant, /applyVoiceTextToDraft/);
  assert.match(quickAssistant, /correctVoiceText\(/);
  assert.match(quickAssistant, /getSpeechRecognitionConstructor\(\)/);
  assert.match(quickAssistant, /当前环境无法访问前端语音识别/);
  assert.match(quickAssistant, /voiceBaseDraftRef/);
  assert.match(quickAssistant, /canUseVoiceRecorder\(\) \|\| Boolean\(getSpeechRecognitionConstructor\(\)\)/);
  assert.match(quickAssistant, /voiceRecognitionFallbackToRecorderRef\.current = shouldFallbackToRecorder/);
  const toggleVoiceIndex = quickAssistant.indexOf("async function toggleVoice()");
  const formatAttachmentSizeIndex = quickAssistant.indexOf("function formatAttachmentSize", toggleVoiceIndex);
  const toggleVoice = quickAssistant.slice(toggleVoiceIndex, formatAttachmentSizeIndex);
  assert.match(toggleVoice, /canUseVoiceRecorder\(\)[\s\S]{0,120}await startVoiceRecorderInput\(\)/);
  assert.doesNotMatch(assistantDock, /isVoiceCorrectionEnabled/);
  assert.doesNotMatch(assistantDock, /!isVoiceCorrectionEnabled\(latestSettings\)/);
  assert.match(assistantDock, /correctVoiceTranscript/);
  assert.match(assistantDock, /canUseRecordedVoiceInput\(\) \|\| Boolean\(getSpeechRecognitionConstructor\(\)\)/);
  assert.match(assistantDock, /voiceRecognitionFallbackToRecorderRef\.current = shouldFallbackToRecorder/);

  const startVoiceInputIndex = assistantDock.indexOf("async function startVoiceInput()");
  const stopVoiceInputIndex = assistantDock.indexOf("function stopVoiceInput()", startVoiceInputIndex);
  const startVoiceInput = assistantDock.slice(startVoiceInputIndex, stopVoiceInputIndex);
  assert.match(startVoiceInput, /getSpeechRecognitionConstructor\(\)/);
  assert.match(startVoiceInput, /canUseRecordedVoiceInput\(\)[\s\S]{0,120}await startRecordedVoiceInput\(\)/);
  assert.match(assistantRuntime, /loadAgentPlatformVoiceAsrSettings/);
  assert.match(assistantRuntime, /transcribeOpenAIChatAudio/);
  assert.match(assistantRuntime, /qwen3-asr-flash/);
});

test("desktop pet appearance picker confirms persistence before success feedback", () => {
  const settingsPage = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "pages", "SettingsPage.tsx"),
    "utf8"
  );

  assert.match(settingsPage, /nextState\.appearanceId === appearanceId/);
  assert.match(settingsPage, /桌面仙尊形象切换未生效/);
  assert.match(settingsPage, /disabled=\{Boolean\(desktopPetAppearancePending\) && !selected\}/);
  assert.doesNotMatch(settingsPage, /disabled=\{Boolean\(desktopPetAppearancePending\) \|\| selected\}/);
});

test("desktop pet drag ends on lost pointer signals", () => {
  const desktopPet = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "components", "DesktopPet.tsx"),
    "utf8"
  );
  const mainProcess = fs.readFileSync(path.join(projectRoot, "src", "main", "index.ts"), "utf8");

  assert.match(desktopPet, /lostpointercapture/);
  assert.match(desktopPet, /window\.addEventListener\("pointerup"/);
  assert.match(desktopPet, /window\.addEventListener\("mouseup"/);
  assert.match(desktopPet, /window\.addEventListener\("blur"/);
  assert.match(desktopPet, /window\.addEventListener\("contextmenu"/);
  assert.match(desktopPet, /document\.addEventListener\("visibilitychange"/);
  assert.match(mainProcess, /DESKTOP_PET_DRAG_FORCE_END_MS/);
  assert.match(mainProcess, /webContents\.on\("context-menu"[\s\S]{0,120}endDesktopPetWindowDrag\(\)/);
});

test("desktop pet base mode stays sprite-sized while bubble and preview modes expand separately", () => {
  const mainProcess = fs.readFileSync(path.join(projectRoot, "src", "main", "index.ts"), "utf8");
  const petGeometry = fs.readFileSync(path.join(projectRoot, "src", "main", "desktop-pet.ts"), "utf8");
  const globalStyles = fs.readFileSync(path.join(projectRoot, "src", "renderer", "styles.css"), "utf8");

  assert.match(mainProcess, /return shouldShowBubble \? "bubble" : "base";/);
  assert.doesNotMatch(mainProcess, /shouldHideDesktopPetForMainWindow/);
  assert.doesNotMatch(mainProcess, /syncDesktopPetWindowVisibility/);
  assert.match(petGeometry, /width:\s*202,/);
  assert.match(petGeometry, /height:\s*227/);
  assert.match(petGeometry, /bubble:\s*\{\s*width:\s*202,\s*height:\s*260/s);
  assert.match(globalStyles, /\.desktop-pet-hitbox\s*\{[\s\S]{0,220}width:\s*200px;[\s\S]{0,120}min-height:\s*156px;/);
  assert.match(globalStyles, /\.desktop-pet-image\s*\{[\s\S]{0,120}width:\s*124px;/);
  assert.doesNotMatch(globalStyles, /\.desktop-pet-root:not\(\.has-bubble\):not\(\.has-preview\)\s+\.desktop-pet-image[\s\S]{0,120}width:\s*100%/);
});

test("desktop pet button suppresses native focus rings in the transparent window", () => {
  const globalStyles = fs.readFileSync(path.join(projectRoot, "src", "renderer", "styles.css"), "utf8");

  assert.match(globalStyles, /\.desktop-pet-button\s*\{[\s\S]{0,420}appearance:\s*none;/);
  assert.match(globalStyles, /\.desktop-pet-button\s*\{[\s\S]{0,520}-webkit-tap-highlight-color:\s*transparent;/);
  assert.match(globalStyles, /\.desktop-pet-button:focus,\s*\.desktop-pet-button:focus-visible\s*\{[\s\S]{0,120}outline:\s*none;/);
});

test("desktop pet visual states stay local to renderer priority", () => {
  const desktopPet = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "components", "DesktopPet.tsx"),
    "utf8"
  );
  const sharedDesktopPet = fs.readFileSync(path.join(projectRoot, "src", "shared", "desktop-pet.ts"), "utf8");
  const globalStyles = fs.readFileSync(path.join(projectRoot, "src", "renderer", "styles.css"), "utf8");
  const mainProcess = fs.readFileSync(path.join(projectRoot, "src", "main", "index.ts"), "utf8");
  const preload = fs.readFileSync(path.join(projectRoot, "src", "preload", "index.ts"), "utf8");
  const contracts = fs.readFileSync(path.join(projectRoot, "src", "shared", "contracts.ts"), "utf8");
  const petAssetScript = fs.readFileSync(
    path.join(projectRoot, "scripts", "generate-desktop-pet-assets.mjs"),
    "utf8"
  );

  assert.match(desktopPet, /type DesktopPetVisualStatus = DesktopPetStatus \| "dragging" \| "hover" \| "message" \| "thinking" \| "dancing"/);
  assert.match(desktopPet, /const \[isHovering, setIsHovering\] = useState\(false\)/);
  assert.match(desktopPet, /const \[isKeyboardFocused, setIsKeyboardFocused\] = useState\(false\)/);
  assert.match(desktopPet, /const \[isDancing, setIsDancing\] = useState\(false\)/);
  assert.match(desktopPet, /pointIntersectsVisiblePetArea/);
  assert.match(desktopPet, /pointIntersectsElement\("\.desktop-pet-image"/);
  assert.match(desktopPet, /window\.addEventListener\("mousemove", handleWindowMouseMove\)/);
  assert.match(desktopPet, /desktopPet\.setMouseInteractive\(interactive\)/);
  assert.match(desktopPet, /typeof window\.electronAPI\.desktopPet\.onDanceRequested === "function"/);
  assert.match(desktopPet, /desktopPet\.onDanceRequested\(startDance\)/);
  assert.match(desktopPet, /isDragging[\s\S]{0,120}\? "dragging"/);
  assert.match(desktopPet, /isDancing && appearanceId === DEFAULT_DESKTOP_PET_APPEARANCE_ID[\s\S]{0,80}\? "dancing"/);
  assert.match(desktopPet, /displayStatus === "running" \|\| displayStatus === "awaiting"/);
  assert.match(desktopPet, /hasMessageReaction[\s\S]{0,80}\? "message"/);
  assert.match(desktopPet, /displayStatus === "idle" && !isDragging && !hasMessageReaction/);
  assert.match(desktopPet, /isHovering \|\| isKeyboardFocused/);
  assert.match(desktopPet, /getDesktopPetStatusAssetPath\(appearanceId, visualStatus\)/);
  assert.match(desktopPet, /messagePreview \|\| "有新消息"/);
  assert.match(desktopPet, /const previewPanel = petState\.previewPanel\?\.visible \? petState\.previewPanel : null/);
  assert.match(desktopPet, /const showPreviewPanel = !isDragging && Boolean\(previewPanel\)/);
  assert.match(desktopPet, /const showBubble = !isDragging && !showPreviewPanel && bubbleText\.length > 0/);
  assert.match(desktopPet, /desktop-pet-preview-toggle/);
  assert.match(desktopPet, /desktopPet\.setPreviewExpanded/);
  assert.match(desktopPet, /onPointerEnter=\{handlePointerEnter\}/);
  assert.match(desktopPet, /onPointerLeave=\{handlePointerLeave\}/);
  assert.match(desktopPet, /onFocus=\{handleButtonFocus\}/);
  assert.match(desktopPet, /onBlur=\{handleButtonBlur\}/);
  assert.match(desktopPet, /matches\(":focus-visible"\)/);
  assert.match(sharedDesktopPet, /id:\s*"dario"/);
  assert.match(sharedDesktopPet, /id:\s*"mini-sama"/);
  assert.match(sharedDesktopPet, /assetBasePath:\s*"\.\/desktop-pet\/dario"/);
  assert.match(sharedDesktopPet, /assetBasePath:\s*"\.\/desktop-pet\/mini-sama"/);
  assert.match(sharedDesktopPet, /dragging:\s*"pet-dragging\.png"/);
  assert.match(sharedDesktopPet, /hover:\s*"pet-hover\.png"/);
  assert.match(sharedDesktopPet, /message:\s*"pet-message\.png"/);
  assert.match(sharedDesktopPet, /thinking:\s*"pet-thinking\.png"/);
  assert.match(sharedDesktopPet, /dancing:\s*"pet-idle\.png"/);
  assert.match(globalStyles, /\.desktop-pet-root\.is-hover\s+\.desktop-pet-image/);
  assert.match(globalStyles, /\.desktop-pet-root\.is-dancing\s+\.desktop-pet-image/);
  assert.match(globalStyles, /\.desktop-pet-root\.is-dragging\s+\.desktop-pet-image/);
  assert.match(globalStyles, /\.desktop-pet-root\.is-thinking\s+\.desktop-pet-image/);
  assert.match(globalStyles, /\.desktop-pet-root\.is-message\s+\.desktop-pet-image/);
  assert.match(globalStyles, /\.desktop-pet-preview/);
  assert.match(globalStyles, /\.desktop-pet-preview-toggle/);
  assert.match(globalStyles, /@keyframes desktop-pet-hover-reaction/);
  assert.match(globalStyles, /@keyframes desktop-pet-dance/);
  assert.match(globalStyles, /@keyframes desktop-pet-dragging/);
  assert.match(globalStyles, /@keyframes desktop-pet-thinking/);
  assert.match(globalStyles, /@keyframes desktop-pet-message-nudge/);
  assert.match(mainProcess, /getDesktopPetContextMenuItems\(desktopPetSettings\.appearanceId\)/);
  assert.match(mainProcess, /function setDesktopPetWindowMouseInteractive\(interactive: boolean\)/);
  assert.match(mainProcess, /setIgnoreMouseEvents\(!interactive, \{ forward: true \}\)/);
  assert.match(mainProcess, /desktopPet\.setMouseInteractive/);
  assert.match(mainProcess, /desktopPet\.danceRequested/);
  assert.match(preload, /setMouseInteractive: \(interactive\) => ipcRenderer\.invoke\("desktopPet\.setMouseInteractive", interactive\)/);
  assert.match(preload, /onDanceRequested/);
  assert.match(preload, /desktopPet\.danceRequested/);
  assert.match(contracts, /DesktopPetDanceRequestedListener/);
  assert.match(contracts, /setMouseInteractive: \(interactive: boolean\) => Promise<\{ ok: boolean \}>/);
  assert.match(contracts, /onDanceRequested: \(listener: DesktopPetDanceRequestedListener\) => \(\) => void/);
  assert.match(petAssetScript, /classicVisualVariants = \["idle", "hover", "dragging", "thinking", "message", "done", "error"\]/);
  assert.match(petAssetScript, /dario-a7bdc389/);
  assert.match(petAssetScript, /mini-sama-3ee267a2/);
  assert.match(petAssetScript, /awaiting:\s*"thinking"/);
  assert.match(petAssetScript, /running:\s*"thinking"/);
  assert.match(petAssetScript, /function drawHoverArm/);
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
  const attachmentImagePreview = fs.readFileSync(
    path.join(projectRoot, "src", "renderer", "components", "AttachmentImagePreview.tsx"),
    "utf8"
  );
  const mainProcess = fs.readFileSync(path.join(projectRoot, "src", "main", "index.ts"), "utf8");
  const globalStyles = fs.readFileSync(path.join(projectRoot, "src", "renderer", "styles.css"), "utf8");
  const appendAttachmentResult = quickAssistant.slice(
    quickAssistant.indexOf("async function appendAttachmentResult"),
    quickAssistant.indexOf("async function chooseAttachmentFiles")
  );

  assert.match(quickAssistant, /quickAssistantDisplayMode/);
  assert.match(quickAssistant, /attachmentMenuOpen \? "is-menu-open" : ""/);
  assert.match(quickAssistant, /quickAssistant\.setDisplayMode/);
  assert.match(quickAssistant, /quickAssistant\.pickAttachments/);
  assert.match(quickAssistant, /quickAssistant\.captureScreenshot/);
  assert.match(quickAssistant, /onAttachmentProgress/);
  assert.match(quickAssistant, /quickAssistant\.cancelAttachmentTask/);
  assert.match(assistantDock, /assistant\.cancelAttachmentTask/);
  assert.match(mainProcess, /assistant\.attachmentProgress/);
  assert.match(mainProcess, /cancelAssistantAttachmentTask/);
  assert.match(quickAssistant, /hiddenArtifactIds/);
  assert.match(quickAssistant, /visibleAttachments/);
  assert.match(quickAssistant, /quick-attachment-preview-card/);
  assert.match(quickAssistant, /function removeAttachment/);
  assert.match(quickAssistant, /quick-attachment-remove/);
  assert.match(quickAssistant, /quick-artifact-remove/);
  assert.match(assistantDock, /hiddenArtifactIds/);
  assert.match(assistantDock, /assistant-artifact-remove/);
  assert.match(assistantDock, /previewImageAttachment/);
  assert.match(assistantDock, /assistant-dock-attachment-preview-button/);
  assert.match(assistantDock, /AttachmentImagePreview/);
  assert.doesNotMatch(quickAssistant, /quick-mode-pill/);
  assert.match(quickAssistant, /chooseAttachmentFiles/);
  assert.match(quickAssistant, /const showSendAction = hasDraft \|\| attachments\.some/);
  assert.match(quickAssistant, /quick-primary-action/);
  assert.match(quickAssistant, /quick-expand-button/);
  assert.match(quickAssistant, /const composerStatus = isExpanded \?/);
  assert.match(quickAssistant, /const isSmallTrayMode = !isExpanded && visibleAttachments\.length === 0 && !voiceExpandedComposer/);
  assert.match(quickAssistant, /const showScreenshotMenuItem = !isSmallTrayMode/);
  assert.match(quickAssistant, /attachmentMenuOpen[\s\S]{0,80}\? isSmallTrayMode[\s\S]{0,80}\? "compactMenu"/);
  assert.match(quickAssistant, /attachmentMenuOpen/);
  assert.match(quickAssistant, /attachmentMenuCloseTimerRef/);
  assert.match(quickAssistant, /attachmentMenuOpenTimerRef/);
  assert.match(quickAssistant, /setAttachmentMenuOpen\(true\);[\s\S]{0,40}, 420\);/);
  assert.match(quickAssistant, /setAttachmentMenuPinned\(true\)/);
  assert.doesNotMatch(quickAssistant, /function toggleAttachmentMenu\(\)[\s\S]{0,180}handleChooseAttachmentFromMenu/);
  assert.match(quickAssistant, /attachment-action-menu/);
  assert.doesNotMatch(quickAssistant, /window\.electronAPI\.assistant\.pickAttachments\(activeChatId\)/);
  assert.match(quickAssistant, /captureScreenshotQuestion/);
  assert.match(quickAssistant, /\{showScreenshotMenuItem \? \(/);
  assert.match(quickAssistant, /quick-attachment-preview-image-button/);
  assert.match(quickAssistant, /openMainAssistant\(activeChatId\)/);
  assert.doesNotMatch(quickAssistant, /AttachmentImagePreview/);
  assert.doesNotMatch(quickAssistant, /setPreviewImageAttachment/);
  assert.doesNotMatch(quickAssistant, /quick-screenshot-button/);
  assert.match(mainProcess, /captureWindowSelectionFallback/);
  assert.match(mainProcess, /const cropped = await captureScreenshotImage\(display, selection, source\)/);
  assert.match(mainProcess, /id=\\"shade\\"/);
  assert.match(attachmentImagePreview, /createPortal/);
  assert.match(attachmentImagePreview, /attachment-image-preview-toolbar/);
  assert.match(attachmentImagePreview, /attachment-image-preview-filmstrip/);
  assert.doesNotMatch(appendAttachmentResult, /setIsExpanded\(true\)/);
  assert.match(globalStyles, /grid-template-columns:\s*42px minmax\(0, 1fr\) 42px 46px/);
  assert.match(globalStyles, /\.quick-assistant\.is-compact\.has-attachments/);
  assert.match(globalStyles, /\.quick-assistant\.is-compact\.is-menu-open/);
  assert.match(globalStyles, /\.quick-assistant\.is-compact\.has-attachments\.is-menu-open/);
  assert.match(globalStyles, /\.quick-attachment-preview-card/);
  assert.match(globalStyles, /\.quick-attachment-remove/);
  assert.match(globalStyles, /\.attachment-action-menu/);
  assert.match(globalStyles, /\.attachment-action-menu-root::before/);
  assert.match(globalStyles, /bottom:\s*calc\(100% \+ 4px\)/);
  assert.match(globalStyles, /\.quick-artifact-remove/);
  assert.match(globalStyles, /\.assistant-artifact-remove/);
  assert.match(globalStyles, /\.assistant-dock-attachment-preview-button/);
  assert.match(globalStyles, /\.attachment-image-preview-backdrop/);
  assert.match(globalStyles, /z-index:\s*2147483000/);
  assert.match(globalStyles, /\.attachment-image-preview-toolbar/);
  assert.match(globalStyles, /\.attachment-image-preview-filmstrip/);
  assert.doesNotMatch(globalStyles, /\.quick-mode-pill/);
  assert.match(globalStyles, /font-size:\s*18px/);
  assert.doesNotMatch(globalStyles, /\.quick-screenshot-entry/);
  assert.match(globalStyles, /\.quick-composer\.has-status/);
});
