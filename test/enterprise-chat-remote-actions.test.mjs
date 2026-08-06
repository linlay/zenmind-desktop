import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const { __testInternals } = await import("../dist-electron/main/enterprise-chat-runtime.js");
const { setMainLocaleForCurrentProcess } = await import("../dist-electron/main/i18n/main-i18n.js");

test("enterprise chat uses structured device-targeted remote actions and flat site domains", async () => {
  const [runtime, actions, desktopActions, bridge, appShell, marketPage, storefront, zhCN, enUS] = await Promise.all([
    readFile(new URL("src/main/enterprise-chat-runtime.ts", root), "utf8"),
    readFile(new URL("src/shared/enterprise-chat-actions.ts", root), "utf8"),
    readFile(new URL("src/shared/desktop-actions.ts", root), "utf8"),
    readFile(new URL("src/main/desktop-action-bridge.ts", root), "utf8"),
    readFile(new URL("src/renderer/app-shell/AppShell.tsx", root), "utf8"),
    readFile(new URL("src/renderer/pages/functional-market/index.tsx", root), "utf8"),
    readFile(new URL("src/renderer/pages/functional-market/StorefrontMarket.tsx", root), "utf8"),
    readFile(new URL("src/shared/i18n/dictionaries/zhCN.ts", root), "utf8"),
    readFile(new URL("src/shared/i18n/dictionaries/enUS.ts", root), "utf8"),
  ]);

  assert.match(runtime, /device\.capabilities\.publish/);
  assert.match(runtime, /kind: "desktop_action_result"/);
  assert.match(runtime, /targetDeviceId !== this\.getDeviceInfo\(\)\.deviceId/);
  assert.match(runtime, /localizedDesktopActionSummary\(action, args, fallbackSummary\)/);
  assert.match(runtime, /enterpriseChat\.desktopActionTargetSuffix/);
  assert.match(actions, /desktop\.support\.requestScreenshot/);
  assert.match(actions, /desktop\.website\.open/);
  assert.match(actions, /desktop\.webapp\.updatePreferences/);
  assert.match(actions, /desktop\.skill\.update/);
  assert.match(bridge, /case "desktop\.skill\.update"/);
  assert.match(bridge, /const route = `\/skills\/\$\{encodeURIComponent\(skillKey\)\}`/);
  assert.match(appShell, /resolveSkillManagementWebclientRoute/);
  assert.match(marketPage, /searchParams\.get\("itemId"\)/);
  assert.match(storefront, /setSelectedDetailItem\(initialItem\)/);
  assert.match(zhCN, /"enterpriseChat\.desktopActionWebappOpen": "启动并打开网站应用"/);
  assert.match(enUS, /"enterpriseChat\.desktopActionWebappOpen": "Start and open WebApp"/);
  assert.equal(desktopActions.includes(["desktop", "web", "website"].join(".") + "."), false);
  assert.equal(desktopActions.includes(["desktop", "web", "webapp"].join(".") + "."), false);
});

test("enterprise chat localizes WebApp action summaries for the current Desktop language", (t) => {
  t.after(() => setMainLocaleForCurrentProcess("en-US"));
  const input = {
    requestId: "request-1",
    targetDeviceId: "device-1",
    action: "desktop.webapp.open",
    args: { webappId: "reports" },
  };

  setMainLocaleForCurrentProcess("zh-CN");
  assert.equal(__testInternals.normalizeDesktopAction(input)?.summary, "启动并打开网站应用：reports");

  setMainLocaleForCurrentProcess("en-US");
  assert.equal(__testInternals.normalizeDesktopAction(input)?.summary, "Start and open WebApp: reports");
});
