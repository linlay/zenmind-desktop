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

test("enterprise chat distinguishes people, groups, and service bots in Contacts", () => {
  const panel = readSource(
    "src",
    "renderer",
    "enterprise-chat",
    "EnterpriseChatFloatingPanel.tsx"
  );
  const styles = readSource("src", "renderer", "styles", "enterprise-chat.css");
  const runtime = readSource("src", "main", "enterprise-chat-runtime.ts");

  assert.match(runtime, /record\.kind\) === "service_bot"/u);
  assert.match(panel, /employeeContacts/);
  assert.match(panel, /groupContacts/);
  assert.match(panel, /botContacts/);
  assert.match(panel, /<RobotOutlined \/>/);
  assert.match(panel, /enterprise-chat-contact-kind is-group/);
  assert.match(styles, /\.enterprise-chat-avatar\.is-person/);
  assert.match(styles, /\.enterprise-chat-avatar\.is-bot/);
  assert.match(styles, /\.enterprise-chat-contact-kind\.is-group/);
});

test("enterprise chat exposes an attachment menu and a local profile settings tab", () => {
  const panel = readSource(
    "src",
    "renderer",
    "enterprise-chat",
    "EnterpriseChatFloatingPanel.tsx"
  );
  const preload = readSource("src", "preload", "index.ts");
  const handlers = readSource("src", "main", "ipc", "enterprise-chat-handlers.ts");

  assert.match(panel, /className="enterprise-chat-attachment-menu"/);
  assert.match(panel, /sendSupportBundle/);
  assert.match(panel, /view === "settings"/);
  assert.match(panel, /snapshot\.selfProfile\.motto/);
  assert.match(panel, /selectSelfAvatar/);
  assert.match(preload, /enterpriseChat\.sendSupportBundle/);
  assert.match(preload, /enterpriseChat\.saveSelfProfile/);
  assert.match(handlers, /runtime\.sendSupportBundle/);
  assert.match(handlers, /runtime\.saveSelfProfile/);
});

test("enterprise chat sends a selected Agent Chat through the raw JSONL file path", () => {
  const panel = readSource(
    "src",
    "renderer",
    "enterprise-chat",
    "EnterpriseChatFloatingPanel.tsx"
  );
  const styles = readSource("src", "renderer", "styles", "enterprise-chat.css");
  const preload = readSource("src", "preload", "index.ts");
  const contract = readSource("src", "shared", "contracts", "enterprise-chat.ts");
  const handlers = readSource("src", "main", "ipc", "enterprise-chat-handlers.ts");
  const bridge = readSource("src", "main", "assistant", "core", "agent-platform-bridge.ts");
  const rawMethodStart = bridge.indexOf("async downloadRawChatJSONL(");
  const rawMethodEnd = bridge.indexOf("\n  async getMemorySettings(", rawMethodStart);
  const rawMethod = bridge.slice(rawMethodStart, rawMethodEnd);

  assert.match(panel, /enterpriseChat\.sendAgentChat/);
  assert.match(panel, /assistant\.listChats\(\)/);
  assert.match(panel, /agentChatSearch[\s\S]*chat\.title\.toLocaleLowerCase/);
  assert.match(panel, /className="enterprise-chat-agent-chat-picker"/);
  assert.match(
    panel,
    /window\.confirm\(t\("enterpriseChat\.rawAgentChatConfirm"[\s\S]*enterpriseChat\.sendRawAgentChat/
  );
  assert.match(panel, /sendRawAgentChat\(\{[\s\S]*?conversationId,/);
  assert.match(panel, /clientMessageId:\s*newClientMessageId\(\)/);
  assert.match(styles, /\[data-theme="dark"\] \.enterprise-chat-agent-chat-picker/);
  assert.match(preload, /enterpriseChat\.sendRawAgentChat/);
  assert.match(contract, /interface EnterpriseChatSendRawAgentChatInput/);
  assert.match(handlers, /downloadRawChatJSONL\(chatId\)/);
  assert.match(handlers, /runtime\.sendRawAgentChat\(input, rawChat\)/);
  assert.match(rawMethod, /\/api\/chat\/jsonl\?chatId=/);
  assert.match(rawMethod, /readResponseBytesWithLimit/);
  assert.doesNotMatch(rawMethod, /JSON\.parse|JSON\.stringify/);
  assert.match(bridge, /\/api\/chat\/export\?chatId=\$\{encodeURIComponent\(trimmedChatId\)\}&format=raw/);
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
  assert.match(panel, /decision: "confirm"/);
  assert.match(panel, /decision: "decline"/);
  assert.match(panel, /message\.desktopActionState === "pending"/);
  assert.match(
    panel,
    /async function cancelDesktopAction\(\)[\s\S]*setPendingActionMessage\(null\)[\s\S]*decision: "decline"/
  );
  assert.match(panel, /message\.kind === "desktop_action_request"/);
  assert.doesNotMatch(panel, /message\.kind === "desktop_action"/);
  assert.match(runtime, /input\?\.decision !== "confirm"/);
  assert.match(runtime, /kind: "desktop_action_result"/);
  assert.match(contract, /disposition: "completed" \| "already_handled" \| "not_executable"/);
  assert.match(contract, /deliveryState: "delivered" \| "pending" \| "not_applicable"/);
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
