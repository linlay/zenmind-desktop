// Isolated native WebView composition check, using real Desktop CSS and no user profile.
// Optional: WEBAPP_PREVIEW_ROOT=/path/to/built/frontend node qa/webapp-background-smoke.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { build } from "esbuild";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const output = fs.mkdtempSync(path.join(os.tmpdir(), "webapp-background-"));
await build({ entryPoints: [path.join(repo, "src/renderer/styles.css")], outfile: path.join(output, "shell.css"), bundle: true });
fs.writeFileSync(path.join(output, "host.html"), `<!doctype html><html lang="en" data-theme="light" data-desktop-background="image"><meta charset="utf-8">
<link rel="stylesheet" href="/shell.css"><style>
html,body,#root{width:100%;height:100%;margin:0;overflow:hidden}
.app-shell{height:100%;width:100%;--shell-background-tint:transparent;--chat-work-panel-width:600px}
.app-sidebar-shell{width:160px;flex:0 0 160px}.app-sidebar{width:160px}
.app-content{flex:1}.canonical-webapp-surface{top:0;left:0;width:100%;height:100%}
.external-webview-page.is-app-surface{margin:0;position:absolute;inset:0}
.external-webview-frame{width:100%;height:100%;min-height:0}
.desktop-background-image{visibility:visible}
.fixture-service{height:100%;background:var(--embedded-surface-page-bg)}
</style><div id="root"><div id="shell" class="app-shell is-mac-platform is-mac-translucent-sidebar has-embedded-surface has-webapp-surface">
<div class="desktop-background"><img class="desktop-background-image" src="/wallpaper.svg"></div>
<div class="app-sidebar-shell"><aside class="app-sidebar">Desktop</aside></div>
<div class="app-content"><main class="app-main"><div class="fixture-service" hidden>Service</div></main>
<div class="work-panel-host"><aside class="chat-work-panel is-visible"><div class="chat-work-panel-tabs">WorkPanel</div><div class="chat-work-panel-body"></div></aside></div>
<div class="canonical-webapp-layer"><div class="canonical-webapp-surface is-active">
<div class="embedded-surface-page external-webview-page is-app-surface"><div class="embedded-surface-frame-shell external-webview-frame-shell"><div class="external-webview-panel is-active"><webview src="/guest" class="embedded-surface-frame external-webview-frame"></webview></div></div></div>
</div></div></div></div></div><script>
window.configure = (platform, mode, presentation, kind = 'webapp') => {
  document.documentElement.dataset.theme = mode;
  const workpanel = presentation !== 'main';
  const shell = document.getElementById('shell');
  shell.className = 'app-shell has-embedded-surface ' + (platform === 'mac' ? 'is-mac-platform is-mac-translucent-sidebar' : 'is-windows-platform')
    + (workpanel ? ' has-chat-work-panel has-service-webview-surface has-work-panel-webapp-surface' : kind === 'webapp' ? ' has-webapp-surface' : ' has-browser-chrome-surface')
    + (presentation === 'fullscreen' ? ' is-work-panel-fullscreen' : '');
  document.querySelector('.work-panel-host').classList.toggle('is-fullscreen', presentation === 'fullscreen');
  document.querySelector('.fixture-service').hidden = !workpanel;
  const content = document.querySelector('.app-content').getBoundingClientRect();
  const target = document.querySelector(workpanel ? '.chat-work-panel-body' : '.app-main').getBoundingClientRect();
  Object.assign(document.querySelector('.canonical-webapp-surface').style, {
    left: (target.left - content.left) + 'px', top: (target.top - content.top) + 'px', width: target.width + 'px', height: target.height + 'px'
  });
};
</script></html>`);
fs.writeFileSync(path.join(output, "wallpaper.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="900"><path fill="#a85424" d="M0 0h640v900H0z"/><path fill="#2458a8" d="M640 0h640v900H640z"/></svg>');
const env = { ...process.env, WEBAPP_QA_DIR: output, WEBAPP_QA_REPO: repo };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(require("electron"), [path.join(repo, "qa/webapp-background-checks.cjs")], { env, stdio: "inherit" });
const code = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => {
    if (signal) console.error(`Electron QA stopped by ${signal}`);
    resolve(code);
  });
});
console.log(`WebApp background QA output: ${output}`);
process.exitCode = typeof code === "number" ? code : 1;
