// Run after building Main and renderer. Exercises the actual development and
// packaged preloads, production CSP/assets and persistence across two processes.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { build } from "esbuild";
import { loadBrandConfig, resolveBrandId, runtimeBrandPayload } from "../scripts/lib/brand-config.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const APP_BRAND = runtimeBrandPayload(loadBrandConfig(repo, resolveBrandId()));
const built = path.join(repo, "build", "brands", APP_BRAND.id);
const preloads = [path.join(repo, "dist-electron/preload/index.js"), path.join(built, "bundle/dist-electron/preload/index.js")];
for (const preload of preloads) {
  if (!fs.existsSync(preload)) throw new Error("Build Main before running the appearance release check.");
}
const images = [];
for (const name of fs.readdirSync(path.join(built, "renderer/assets")).filter((name) => name.endsWith(".js"))) {
  const source = fs.readFileSync(path.join(built, "renderer/assets", name), "utf8");
  for (const match of source.matchAll(/"(data:image\/svg\+xml,[^"]+)"/g)) {
    if (match[1].includes("%23D2E2D6") || match[1].includes("%23142C28")) images.push(JSON.parse(`"${match[1]}"`));
  }
}
if (new Set(images).size !== 2) throw new Error("The renderer build must contain both bundled mist wallpapers.");
const html = fs.readFileSync(path.join(built, "renderer/index.html"), "utf8");
const csp = html.match(/<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?>/i)?.[0];
if (!csp) throw new Error("Production renderer CSP is missing.");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-appearance-release-"));
const fromRenderer = (file) => JSON.stringify(path.join(repo, "src/renderer", file));
await build({
  stdin: { contents: `
    import React, { useLayoutEffect } from 'react';
    import { createRoot } from 'react-dom/client';
    import { AppearanceProvider, useAppearance } from ${fromRenderer("appearance/AppearanceProvider.tsx")};
    import { SkinSettings } from ${fromRenderer("appearance/SkinSettings.tsx")};
    import { DesktopBackground } from ${fromRenderer("appearance/DesktopBackground.tsx")};
    import { I18nProvider } from ${fromRenderer("i18n/I18nProvider.tsx")};
    import ${fromRenderer("styles.css")};
    import ${fromRenderer("pages/settings/SettingsPage.css")};
    function Probe() {
      const appearance = useAppearance();
      useLayoutEffect(() => { window.appearanceRelease = appearance; });
      return <div className="app-shell is-${process.platform === "win32" ? "windows" : "mac"}-platform">
        <DesktopBackground background={appearance.background} fallback={appearance.skin.backgrounds?.[appearance.resolvedTheme]} />
        <main className="release-settings settings-page">
          <input id="preserved-draft" aria-label="Draft" defaultValue="Keep this draft" />
          <div className="settings-appearance-panel"><SkinSettings /></div>
        </main>
      </div>;
    }
    createRoot(document.getElementById('root')).render(<React.StrictMode><I18nProvider><AppearanceProvider><Probe /></AppearanceProvider></I18nProvider></React.StrictMode>);
  `, resolveDir: repo, loader: "tsx" },
  outfile: path.join(root, "fixture.js"), bundle: true, platform: "browser", jsx: "automatic", format: "iife",
  loader: { ".png": "dataurl", ".jpg": "dataurl", ".svg": "dataurl" },
  define: { "process.env.NODE_ENV": '"production"', __DESKTOP_APP_BRAND__: JSON.stringify(APP_BRAND) }
});
fs.writeFileSync(path.join(root, "index.html"), `<!doctype html><html><head><meta charset="UTF-8">${csp}<link rel="stylesheet" href="./fixture.css"><style>
  .release-settings{position:relative;z-index:1;width:min(760px,calc(100% - 64px));margin:64px auto;padding:24px;background:var(--surface-strong);border-radius:var(--control-radius-lg);overflow:auto}
  #preserved-draft{display:block;margin-bottom:18px} .release-settings .desktop-skin-settings{border-top:0}
  *{transition:none!important;animation:none!important}
</style></head><body><div id="root"></div><script src="./fixture.js"></script></body></html>`);
fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ repo, root, preloads, images }));
const main = path.join(root, "main.cjs");
fs.writeFileSync(main, `require(${JSON.stringify(path.join(repo, "qa/desktop-appearance-release-checks.cjs"))})(require('./config.json'));`);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.BRAND = APP_BRAND.id;
for (const phase of ["write", "restart"]) {
  const child = spawn(require("electron"), [main, `--appearance-phase=${phase}`], { env, stdio: ["ignore", "inherit", "inherit"] });
  const timer = setTimeout(() => child.kill("SIGTERM"), 45000);
  const code = await new Promise((resolve, reject) => { child.on("exit", resolve); child.on("error", reject); });
  clearTimeout(timer);
  if (code !== 0) { console.error("Appearance release fixture:", root); process.exit(code ?? 1); }
}
console.log(JSON.stringify({ ok: true, developmentPreload: preloads[0], packagedPreload: preloads[1], separateProcessRestart: true, productionWallpaperAssets: images.length, report: path.join(root, "restart.json"), screenshots: root }));
