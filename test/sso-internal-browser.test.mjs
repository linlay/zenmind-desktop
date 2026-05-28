import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");

test("Desktop SSO login and logout open the embedded SSO browser tab", () => {
  const source = fs.readFileSync(path.join(projectRoot, "src", "main", "index.ts"), "utf8");
  const ssoHandlersSource = fs.readFileSync(path.join(projectRoot, "src", "main", "ipc", "sso-handlers.ts"), "utf8");
  const ssoControllerSource = fs.readFileSync(path.join(projectRoot, "src", "main", "sso-controller.ts"), "utf8");
  const platformAdapterSource = fs.readFileSync(path.join(projectRoot, "src", "main", "platform-adapter.ts"), "utf8");
  const oidcSsoSource = fs.readFileSync(path.join(projectRoot, "src", "main", "oidc-sso.ts"), "utf8");
  const startLoginBlock = ssoHandlersSource.match(/ipcMain\.handle\("sso\.startLogin"[\s\S]*?ipcMain\.handle\("sso\.logout"/u)?.[0] ?? "";
  const logoutBlock = ssoHandlersSource.match(/ipcMain\.handle\("sso\.logout"[\s\S]*?\n\}/u)?.[0] ?? "";

  assert.match(ssoControllerSource, /const DESKTOP_SSO_WEBVIEW_PARTITION = "persist:zenmind-desktop-sso";/u);
  assert.match(platformAdapterSource, /function getDesktopSsoBrowserUserAgent/u);
  assert.match(platformAdapterSource, /Electron\//u);
  assert.match(platformAdapterSource, /\.replace\([^;]+Electron[^;]+/u);
  assert.match(ssoControllerSource, /partition: DESKTOP_SSO_WEBVIEW_PARTITION/u);
  assert.match(ssoControllerSource, /userAgent = getDesktopSsoBrowserUserAgent\(options\.platform\)/u);
  assert.match(ssoControllerSource, /fromPartition\(DESKTOP_SSO_WEBVIEW_PARTITION\)/u);
  assert.match(ssoControllerSource, /setProxy\(\{\s*proxyRules: "direct:\/\/"\s*\}\)/u);
  assert.match(ssoControllerSource, /async syncBrowserCookies\(\)/u);
  assert.match(ssoControllerSource, /defaultSession/u);
  assert.match(ssoControllerSource, /getDesktopSsoProxyBrowserCookieDetails\(\)/u);
  assert.match(oidcSsoSource, /browserUrl: oidcConfig\.loginUrl \? undefined : buildDesktopSsoProxyUrl\(authorizeUrl\)/u);
  assert.match(startLoginBlock, /onBeforeStatusChanged: async \(status(?:: any)?\) => \{[\s\S]{0,180}if \(status\.authenticated\) \{[\s\S]{0,140}await desktopSsoController\.syncBrowserCookies\(\);/u);
  assert.match(startLoginBlock, /desktopSsoController\.openBrowserUrl\(\{\s*url: result\.browserUrl \|\| result\.authorizeUrl,[\s\S]*?resolveRedirect: Boolean\(result\.browserUrl\)\s*\}\)/u);
  assert.match(startLoginBlock, /failDesktopSsoFlow\(message\)/u);
  assert.match(logoutBlock, /await desktopSsoController\.clearBrowserCookies\(\);/u);
  assert.match(logoutBlock, /desktopSsoController\.openBrowserUrl\(\{\s*url: result\.browserUrl \|\| result\.logoutUrl,[\s\S]*?resolveRedirect: false\s*\}\)/u);
  assert.match(logoutBlock, /failDesktopSsoFlow\(message\)/u);
  assert.match(source, /registerSsoIpcHandlers\(ipcMain,/u);
  assert.match(source, /if \(input\.requireOperableTarget === false\) \{\s*return \{\s*ok: true,/u);
  assert.match(source, /message: `已将「\$\{input\.label \|\| targetUrl\}」发送到内置浏览器。`/u);
  assert.doesNotMatch(source, /openUrlInChrome/u);
  assert.doesNotMatch(source, /getDesktopSsoChromeProfileDir/u);
});
