import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");

test("Desktop SSO login and logout open the embedded SSO browser tab", () => {
  const source = fs.readFileSync(path.join(projectRoot, "src", "main", "index.ts"), "utf8");
  const oidcSsoSource = fs.readFileSync(path.join(projectRoot, "src", "main", "oidc-sso.ts"), "utf8");
  const startLoginBlock = source.match(/ipcMain\.handle\("sso\.startLogin"[\s\S]*?ipcMain\.handle\("sso\.logout"/u)?.[0] ?? "";
  const logoutBlock = source.match(/ipcMain\.handle\("sso\.logout"[\s\S]*?ipcMain\.handle\("clipboard\.writeText"/u)?.[0] ?? "";

  assert.match(source, /const DESKTOP_SSO_WEBVIEW_PARTITION = "persist:zenmind-desktop-sso";/u);
  assert.match(source, /function getDesktopSsoBrowserUserAgent\(\)/u);
  assert.match(source, /Electron\//u);
  assert.match(source, /\.replace\([^;]+Electron[^;]+/u);
  assert.match(source, /partition: DESKTOP_SSO_WEBVIEW_PARTITION/u);
  assert.match(source, /userAgent: getDesktopSsoBrowserUserAgent\(\)/u);
  assert.match(source, /session\.fromPartition\(DESKTOP_SSO_WEBVIEW_PARTITION\)/u);
  assert.match(source, /setProxy\(\{\s*proxyRules: "direct:\/\/"\s*\}\)/u);
  assert.match(source, /async function syncDesktopSsoBrowserCookies\(\)/u);
  assert.match(source, /session\.defaultSession/u);
  assert.match(source, /getDesktopSsoProxyBrowserCookieDetails\(\)/u);
  assert.match(oidcSsoSource, /browserUrl: oidcConfig\.loginUrl \? undefined : buildDesktopSsoProxyUrl\(authorizeUrl\)/u);
  assert.match(startLoginBlock, /onBeforeStatusChanged: async \(status\) => \{[\s\S]{0,160}if \(status\.authenticated\) \{[\s\S]{0,120}await syncDesktopSsoBrowserCookies\(\);/u);
  assert.match(startLoginBlock, /openDesktopSsoBrowserUrl\(\{\s*url: result\.browserUrl \|\| result\.authorizeUrl,\s*label: "IAM 登录",\s*browserOrigin: result\.browserUrl \? undefined : result\.browserOrigin,\s*resolveRedirect: Boolean\(result\.browserUrl\)\s*\}\)/u);
  assert.match(startLoginBlock, /failDesktopSsoFlow\(browserOpenResult\.message\)/u);
  assert.match(logoutBlock, /await clearDesktopSsoBrowserCookies\(\);/u);
  assert.match(logoutBlock, /openDesktopSsoBrowserUrl\(\{\s*url: result\.browserUrl \|\| result\.logoutUrl,\s*label: "IAM 登出",\s*browserOrigin: result\.browserUrl \? undefined : result\.browserOrigin,\s*resolveRedirect: false\s*\}\)/u);
  assert.match(logoutBlock, /failDesktopSsoFlow\(browserOpenResult\.message\)/u);
  assert.match(source, /if \(input\.requireOperableTarget === false\) \{\s*return \{\s*ok: true,/u);
  assert.match(source, /message: `已将「\$\{input\.label \|\| targetUrl\}」发送到内置浏览器。`/u);
  assert.doesNotMatch(source, /openUrlInChrome/u);
  assert.doesNotMatch(source, /getDesktopSsoChromeProfileDir/u);
});
