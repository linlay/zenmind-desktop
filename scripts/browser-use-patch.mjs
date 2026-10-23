import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const pinned = JSON.parse(fs.readFileSync(new URL("../patches/playwright-browser-use/upstream-lock.json", import.meta.url), "utf8"));
export const browserUseUpstream = Object.freeze({
  mcp: "0.0.83",
  core: "1.64.0-alpha-1790635538000",
  commit: "e8149b8257d32dcf8f72573ecc43e72439da7080",
  sourceSha256: "cd6730be1bbcff00771a0fc1390f200306d28428ce68e305420ca623cb39cdeb",
  patch: "DESKTOP_BROWSER_USE_PATCH_V1",
  packages: pinned.packages,
  extension: pinned.extension
});

export function patchBrowserUseUpstream(rootDir) {
  const packageDir = path.join(rootDir, "node_modules/playwright-core");
  const corePackage = JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8"));
  const mcpPackage = JSON.parse(fs.readFileSync(path.join(rootDir, "node_modules/@playwright/mcp/package.json"), "utf8"));
  const playwrightPackage = JSON.parse(fs.readFileSync(path.join(rootDir, "node_modules/playwright/package.json"), "utf8"));
  if (corePackage.version !== browserUseUpstream.core || playwrightPackage.version !== browserUseUpstream.core || mcpPackage.version !== browserUseUpstream.mcp || pinned.coreBundleSha256 !== browserUseUpstream.sourceSha256 || pinned.coreGitHead !== browserUseUpstream.commit) {
    throw new Error("Browser Use upstream versions differ from the reviewed versions");
  }
  const filename = path.join(packageDir, "lib/coreBundle.js");
  const originalFile = filename + ".desktop-original";
  const adapter = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "browser-use-upstream-adapter.cjs"), "utf8");
  const fingerprint = crypto.createHash("sha256").update(adapter).update(fs.readFileSync(fileURLToPath(import.meta.url))).digest("hex");
  const marker = `/* ${browserUseUpstream.patch} ${fingerprint} */`;
  let source = fs.readFileSync(filename, "utf8");
  if (source.startsWith(marker)) return packageDir;
  if (source.startsWith(`/* ${browserUseUpstream.patch}`)) {
    if (!fs.existsSync(originalFile)) throw new Error("Browser Use patch changed; reinstall the reviewed dependency before rebuilding");
    source = fs.readFileSync(originalFile, "utf8");
  }
  if (crypto.createHash("sha256").update(source).digest("hex") !== browserUseUpstream.sourceSha256) {
    throw new Error("Browser Use upstream source checksum differs; review the patch before upgrading");
  }
  fs.writeFileSync(originalFile, source);
  const replace = (before, after) => {
    if (source.split(before).length !== 2) throw new Error(`Browser Use patch anchor is not unique: ${before.slice(0, 65)}`);
    source = source.replace(before, after);
  };
  replace(`      currentTab() {\n        return this._currentTab;\n      }`, `      currentTab() {\n        return this._desktopPinnedTab === undefined ? this._currentTab : this.desktopPinnedTab();\n      }\n      desktopPinnedTab() {\n        const tab = this._desktopPinnedTab;\n        if (!tab || tab.page.isClosed() || tab.crashed || !this._tabs.includes(tab))\n          throw Object.assign(new Error("The selected browser page is no longer available"), { code: "surface_not_found" });\n        return tab;\n      }`);
  replace(`      currentTabOrDie() {\n        if (!this._currentTab)`, `      currentTabOrDie() {\n        if (this._desktopPinnedTab !== undefined) return this.desktopPinnedTab();\n        if (!this._currentTab)`);
  replace(`      async ensureTab() {\n        await this.ensureBrowserContext();`, `      async ensureTab() {\n        await this.ensureBrowserContext();\n        if (this._desktopPinnedTab !== undefined) {\n          const tab = this.desktopPinnedTab();\n          await tab.waitForInitialized();\n          return this.desktopPinnedTab();\n        }`);
  replace(`        this._tabs.push(tab2);\n        if (!this._currentTab)`, `        tab2.desktopPageId = require("crypto").randomUUID();\n        this._tabs.push(tab2);\n        this._desktopOnTab?.(tab2);\n        if (!this._currentTab)`);
  replace(`      async _downloadStarted(download) {\n        const outputFile2 =`, `      async _downloadStarted(download) {\n        if (this.context._desktopDownloadHandler) {\n          await this.context._desktopDownloadHandler(this, download);\n          return;\n        }\n        const outputFile2 =`);
  // Connecting can wait for the user's tab choice. Abort must close the relay even before a Browser exists.
  replace(`async function createExtensionBrowser(channel, executablePath, customUserDataDir, profileDirName, clientName) {`, `async function createExtensionBrowser(channel, executablePath, customUserDataDir, profileDirName, clientName, desktopSignal) {`);
  // Filesystem discovery can miss an installed/enabled extension. It is a profile hint,
  // never an authorization check; the official connect page still requires Allow/select.
  replace(
    '  if (userDataDir && !executablePath && (!profileDirectory || !await isExtensionInstalledInProfile(import_path60.default.join(userDataDir, profileDirectory))))\n    throw new Error(`Playwright Extension not found in "${profileDirectory ? import_path60.default.join(userDataDir, profileDirectory) : userDataDir}". Install it from ${playwrightExtensionInstallUrl}, or set the PLAYWRIGHT_MCP_EXECUTABLE_PATH environment variable to use a browser at a custom location.`);',
    '  // Desktop: disk discovery supplies only a profile hint. A miss still uses the official authorization handshake.'
  );
  replace(`  const relay = new CDPRelayServer(channel, executablePath, customUserDataDir, profileDirectory);\n  await relay.start();`, `  const relay = new CDPRelayServer(channel, executablePath, customUserDataDir, profileDirectory);\n  const desktopAbort = () => relay.stop();\n  if (desktopSignal?.aborted) throw Object.assign(new Error("Browser connection cancelled"), { code: "cancelled" });\n  desktopSignal?.addEventListener("abort", desktopAbort, { once: true });\n  await relay.start();\n  if (desktopSignal?.aborted) { relay.stop(); throw Object.assign(new Error("Browser connection cancelled"), { code: "cancelled" }); }`);
  replace(`    browser.on("disconnected", () => relay.stop());\n    return browser;\n  } catch (error) {\n    relay.stop();\n    throw error;\n  }\n}\nvar import_path60`, `    browser.on("disconnected", () => relay.stop());\n    return browser;\n  } catch (error) {\n    relay.stop();\n    throw error;\n  } finally {\n    desktopSignal?.removeEventListener("abort", desktopAbort);\n  }\n}\nvar import_path60`);
  fs.writeFileSync(filename, `${marker}\n${source}\n${adapter}\n`);
  return packageDir;
}

export function stageBrowserUseRuntime(rootDir, mainDir) {
  const packageDir = patchBrowserUseUpstream(rootDir);
  const target = path.join(mainDir, "browser-use-runtime/playwright-core");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(packageDir, target, { recursive: true, filter: source => !source.endsWith(".desktop-original") });
  fs.writeFileSync(path.join(mainDir, "browser-use-runtime/upstream.json"), JSON.stringify(browserUseUpstream, null, 2) + "\n");
  return target;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  patchBrowserUseUpstream(process.cwd());
}
