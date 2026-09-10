// Real Service WebView preload and appearance relay, isolated from user services.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import { brandBundleElectronDir, loadBrandConfig, resolveBrandId } from '../scripts/lib/brand-config.mjs';

const repo = process.cwd();
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'webclient-appearance-'));
const require = createRequire(import.meta.url);
await build({ entryPoints: ['src/renderer/styles.css'], outfile: path.join(output, 'shell.css'), bundle: true });
await build({
  stdin: { resolveDir: repo, contents: `
    import { createWebclientAppearanceHost } from './src/renderer/service-webview/appearanceHost';
    import { readWebclientAppearanceProjection } from './src/renderer/appearance/webclientProjection';
    import { DESKTOP_SKINS } from './src/renderer/appearance/skins';
    const webview = document.querySelector('webview');
    let config = { mode: 'light', background: true, hostSurface: true };
    let trustedUrl = location.origin;
    let host;
    let skinKeys = [];
    const revisionState = { revision: 0, signature: '' };
    window.deliveries = [];
    const relayTarget = {
      getURL: () => webview.getURL(),
      send: (channel, message) => { window.deliveries.push({ channel, message }); webview.send(channel, message); },
      addEventListener: webview.addEventListener.bind(webview),
      removeEventListener: webview.removeEventListener.bind(webview)
    };
    window.configure = (platform, mode, background = true, hostSurface = true) => {
      config = { mode, background, hostSurface };
      document.documentElement.dataset.theme = mode;
      document.documentElement.dataset.desktopBackground = background ? 'image' : 'none';
      document.documentElement.style.setProperty('--accent', mode === 'light' ? '#217854' : '#82caa2');
      document.documentElement.style.setProperty('--control-hover-bg', 'color-mix(in srgb, var(--accent) 20%, transparent)');
      if (window.useRealSkin) {
        skinKeys.forEach(key => document.documentElement.style.removeProperty(key));
        const tokens = DESKTOP_SKINS.find(skin => skin.id === 'mist').tokens[mode];
        Object.entries(tokens).forEach(([key, value]) => document.documentElement.style.setProperty(key, value));
        skinKeys = Object.keys(tokens);
        document.documentElement.style.setProperty('--qa-background-tint', tokens['--shell-background-tint']);
      }
      document.getElementById('shell').className = 'app-shell has-embedded-surface has-service-webview-surface ' +
        (platform === 'mac' ? 'is-mac-platform is-mac-translucent-sidebar' : 'is-windows-platform');
      host?.refresh();
    };
    window.installHost = () => {
      host = createWebclientAppearanceHost({
        webview: relayTarget, isCurrentGuest: () => webview.isConnected, trustedUrl: () => trustedUrl,
        read: () => readWebclientAppearanceProjection({ resolvedTheme: config.mode, skin: { id: 'mist' } }, config.background && config.hostSurface),
        onNegotiated: theme => { window.routeBootstrapTheme = theme === null ? null : window.routeBootstrapTheme ?? theme; },
        onBackground: value => document.querySelector('.embedded-surface-page').classList.toggle('agent-webclient-host-background', value),
        revisionState
      });
    };
    window.disposeHost = () => host.dispose();
    window.navigateDemo = url => { trustedUrl = url; webview.src = url; };
    window.installHost();
    configure('mac', 'light');
  ` },
  outfile: path.join(output, 'host.js'), bundle: true, platform: 'browser', loader: { '.svg': 'dataurl' }
});
const brand = loadBrandConfig(repo, resolveBrandId());
const preloadSource = path.join(brandBundleElectronDir(repo, brand), 'preload/service-webview.js');
const preloadCopy = path.join(output, 'service-webview-preload.cjs');
fs.copyFileSync(preloadSource, preloadCopy);
const preload = pathToFileURL(preloadCopy).href;
fs.writeFileSync(path.join(output, 'host.html'), `<!doctype html><html data-theme="light" data-desktop-background="image"><meta charset="utf-8">
<link rel="stylesheet" href="/shell.css"><style>
html,body,#root{width:100%;height:100%;margin:0;overflow:hidden}
.app-shell{height:100%;width:100%;--shell-background-tint:var(--qa-background-tint,transparent)}
.app-sidebar-shell{width:160px;flex:0 0 160px}.app-sidebar{width:160px}
.app-content{flex:1}.app-main{height:100%}.embedded-surface-page{height:100%;margin:0}
.embedded-surface-frame-shell{height:100%}.embedded-surface-frame{width:100%;height:100%;min-height:0}
.desktop-background-image{visibility:visible}
</style><div id="root"><div id="shell" class="app-shell">
<div class="desktop-background"><img class="desktop-background-image" src="/wallpaper.svg"></div>
<div class="app-sidebar-shell"><aside class="app-sidebar">Desktop</aside></div>
<div class="app-content"><main class="app-main"><section class="embedded-surface-page embedded-surface-page-embedded">
<div class="embedded-surface-frame-shell"><webview src="/guest" class="embedded-surface-frame" preload="${preload}"></webview></div>
</section></main></div></div></div><script src="/host.js"></script></html>`);
fs.writeFileSync(path.join(output, 'wallpaper.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="900"><path fill="#a85424" d="M0 0h640v900H0z"/><path fill="#2458a8" d="M640 0h640v900H640z"/></svg>');
if (process.env.WEBCLIENT_APPEARANCE_DEMO_URL) fs.copyFileSync(path.join(repo, 'qa/assets/alpine-lake.png'), path.join(output, 'lake.png'));
const env = { ...process.env, WEBCLIENT_APPEARANCE_QA_DIR: output };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(require('electron'), [path.join(repo, 'qa/webclient-appearance-checks.cjs')], { env, stdio: 'inherit' });
const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
console.log('WebClient appearance QA output: ' + output);
process.exitCode = typeof code === 'number' ? code : 1;
