import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readSource(...segments) {
  return fs.readFileSync(path.join(projectRoot, ...segments), "utf8");
}

test("enterprise IM configuration is independent from the enterprise chat business API", () => {
  const appRuntime = readSource("src", "main", "app", "runtime.ts");
  const bootstrap = readSource("src", "main", "desktop-init-bootstrap.ts");
  const profile = readSource("src", "main", "desktop-profile-store.ts");
  const settingsHandlers = readSource("src", "main", "ipc", "settings-handlers.ts");
  const preload = readSource("src", "preload", "index.ts");

  assert.match(appRuntime, /readEnterpriseImSettings\(app, mainProcessContext\.platform\)\.baseUrl/);
  assert.match(appRuntime, /initialEnabled:\s*readEnterpriseImSettings\([\s\S]*?\)\.enabled/);
  assert.match(appRuntime, /reloadConfiguration\([\s\S]*?readEnterpriseImSettings\(app, mainProcessContext\.platform\)\.enabled/);
  assert.match(bootstrap, /defaults\.enterpriseIm/);
  assert.doesNotMatch(bootstrap, /defaults\.imServer/);
  assert.doesNotMatch(profile, /enterpriseChatEnabled/);
  assert.match(settingsHandlers, /settings\.getEnterpriseImSettings/);
  assert.match(settingsHandlers, /settings\.setEnterpriseImEnabled/);
  assert.match(preload, /getEnterpriseImSettings/);
  assert.match(preload, /setEnterpriseImEnabled/);
  assert.match(preload, /enterpriseChat:\s*\{/);
});

test("enterprise chat renderer uses the compact panel and persistent list searches", () => {
  const panel = readSource(
    "src",
    "renderer",
    "enterprise-chat",
    "EnterpriseChatFloatingPanel.tsx"
  );

  assert.match(panel, /const CHAT_PANEL_WIDTH = 400;/);
  assert.match(panel, /const CHAT_PANEL_HEIGHT = 500;/);
  assert.match(panel, /Math\.min\(CHAT_PANEL_WIDTH, viewport\.width - 24\)/);
  assert.match(panel, /Math\.min\(CHAT_PANEL_HEIGHT, viewport\.height - 82\)/);
  assert.match(panel, /const \[chatSearch, setChatSearch\] = useState\(""\);/);
  assert.match(panel, /const \[contactSearch, setContactSearch\] = useState\(""\);/);
  assert.match(panel, /conversationTitle\(conversation\)[\s\S]*peer\?\.email[\s\S]*conversationPreview\(conversation\)/);
  assert.match(panel, /\[user\.displayName, user\.email\]/);
});

test("enterprise chat deletion remains a renderer-only sequence-aware hide", () => {
  const panel = readSource(
    "src",
    "renderer",
    "enterprise-chat",
    "EnterpriseChatFloatingPanel.tsx"
  );
  const preload = readSource("src", "preload", "index.ts");

  assert.match(panel, /zenmind\.enterpriseChat\.hiddenConversations\.v1/);
  assert.match(panel, /JSON\.stringify\(\[serverUrl, userId\]\)/);
  assert.match(panel, /lastSeq <= preference\.lastSeq/);
  assert.match(panel, /conversation\.lastSeq > hiddenAtSeq/);
  assert.match(panel, /restoreHiddenConversation\([\s\S]*next\.activeConversationId/);
  assert.match(panel, /window\.confirm\(t\("enterpriseChat\.deleteConversationConfirm"/);
  assert.doesNotMatch(panel, /electronAPI\.enterpriseChat\.delete/);
  assert.doesNotMatch(preload, /enterpriseChat\.deleteConversation/);
});

test("enterprise chat screenshot button opens three explicit capture levels", () => {
  const panel = readSource(
    "src",
    "renderer",
    "enterprise-chat",
    "EnterpriseChatFloatingPanel.tsx"
  );
  const contract = readSource("src", "shared", "contracts", "enterprise-chat.ts");
  const runtime = readSource("src", "main", "enterprise-chat-runtime.ts");

  assert.match(panel, /className="enterprise-chat-screenshot-menu"/);
  assert.match(panel, /sendScreenshot\("region"\)/);
  assert.match(panel, /sendScreenshot\("window"\)/);
  assert.match(panel, /sendScreenshot\("desktop"\)/);
  assert.doesNotMatch(panel, /onClick=\{\(\) => void sendScreenshot\(\)\}/);
  assert.match(contract, /EnterpriseChatScreenshotMode = "region" \| "window" \| "desktop"/);
  assert.match(runtime, /captureScreenshot\(mode\)/);
});

test("enterprise chat receives Desktop actions but exposes no action sending path", () => {
  const panel = readSource(
    "src",
    "renderer",
    "enterprise-chat",
    "EnterpriseChatFloatingPanel.tsx"
  );
  const preload = readSource("src", "preload", "index.ts");
  const contract = readSource("src", "shared", "contracts", "enterprise-chat.ts");
  const desktopApi = readSource("src", "shared", "contracts", "desktop-api.ts");
  const handlers = readSource("src", "main", "ipc", "enterprise-chat-handlers.ts");
  const runtime = readSource("src", "main", "enterprise-chat-runtime.ts");
  const appRuntime = readSource("src", "main", "app", "runtime.ts");

  assert.doesNotMatch(panel, /new-action|sendDesktopAction|desktopActionName/);
  assert.doesNotMatch(preload, /enterpriseChat\.sendDesktopAction/);
  assert.doesNotMatch(contract, /EnterpriseChatSendDesktopActionInput/);
  assert.doesNotMatch(desktopApi, /sendDesktopAction/);
  assert.doesNotMatch(handlers, /enterpriseChat\.sendDesktopAction/);
  assert.doesNotMatch(runtime, /async sendDesktopAction\(/);
  assert.match(panel, /className="enterprise-chat-action-confirm-backdrop"/);
  assert.match(panel, /role="alertdialog"/);
  assert.match(panel, /confirmed: true/);
  assert.match(runtime, /input\?\.confirmed !== true/);
  assert.doesNotMatch(
    appRuntime,
    /executeDesktopAction: async \(request\) => \{[\s\S]{0,700}showMessageBox\(/
  );
});

test("current Desktop window capture temporarily hides enterprise chat chrome", () => {
  const appRuntime = readSource("src", "main", "app", "runtime.ts");

  assert.match(
    appRuntime,
    /ENTERPRISE_CHAT_WINDOW_CAPTURE_HIDE_CSS[\s\S]*enterprise-chat-floating[\s\S]*visibility: hidden !important/
  );
  assert.match(
    appRuntime,
    /captureEnterpriseChatScreenshot\(mode\)[\s\S]*mode !== "window"[\s\S]*insertCSS\([\s\S]*ENTERPRISE_CHAT_WINDOW_CAPTURE_HIDE_CSS[\s\S]*captureDesktopScreenshotForWebview\(mode\)[\s\S]*removeInsertedCSS\(insertedCssKey\)/
  );
});

test("enterprise chat image preview escapes the compact panel through a portal", () => {
  const panel = readSource(
    "src",
    "renderer",
    "enterprise-chat",
    "EnterpriseChatFloatingPanel.tsx"
  );
  const styles = readSource("src", "renderer", "styles", "enterprise-chat.css");

  assert.match(panel, /import \{ createPortal \} from "react-dom"/);
  assert.match(panel, /className="enterprise-chat-image-preview-trigger"/);
  assert.match(
    panel,
    /createPortal\([\s\S]*className="enterprise-chat-image-preview-backdrop"[\s\S]*document\.body/
  );
  assert.match(styles, /\.enterprise-chat-image-preview-backdrop\s*\{[\s\S]*position:\s*fixed;[\s\S]*inset:\s*0;/);
  assert.match(styles, /max-width:\s*calc\(100vw - 96px\)/);
  assert.match(styles, /max-height:\s*calc\(100vh - 104px\)/);
});
