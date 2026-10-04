// Isolated Electron check of the real fullscreen controls and host styles.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { loadBrandConfig, resolveBrandId, runtimeBrandPayload } from "../scripts/lib/brand-config.mjs";

const require = createRequire(import.meta.url);
const output = path.resolve("build/qa/work-panel-fullscreen");
fs.mkdirSync(output, { recursive: true });
await build({
  stdin: { resolveDir: process.cwd(), loader: "tsx", contents: `
    import React, { useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { WorkPanelFullscreenControls } from './src/renderer/work-panel/WorkPanelFullscreenControls';
    import './src/renderer/styles/theme.css';
    import './src/renderer/styles/external-webview.css';
    import './src/renderer/styles/app-shell.css';
    function Scene() {
      const [fullscreen, setFullscreen] = useState(false);
      window.setFullscreen = setFullscreen;
      return <div className={'app-shell has-chat-work-panel is-mac-platform' + (fullscreen ? ' is-work-panel-fullscreen' : '')}>
        <div className="app-content"><div className={'work-panel-host' + (fullscreen ? ' is-fullscreen' : '')}>
          {fullscreen && <WorkPanelFullscreenControls isMac isWindows={false} onExit={() => setFullscreen(false)}/>}
          <aside className="chat-work-panel is-visible">
            <div className="chat-work-panel-tabs">Overview · Slides</div>
            <div className="chat-work-panel-body"><div className="chat-work-panel-item is-active">
              <div className="embedded-surface-page external-webview-page has-browser-chrome is-work-panel-browser has-browser-toolbar">
                <div className="external-webview-browser-chrome"><div className="external-webview-toolbar">Back · Forward · Refresh · Address</div></div>
                {React.createElement('webview', { src: './guest.html', style: { display: 'flex', flex: 1, minHeight: 0 }, ref: node => { window.guest = node; } })}
              </div>
            </div></div>
          </aside>
        </div></div>
      </div>;
    }
    createRoot(document.getElementById('root')).render(<Scene/>);
  ` },
  bundle: true, jsx: "automatic", define: {
    "process.env.NODE_ENV": '"production"',
    __DESKTOP_APP_BRAND__: JSON.stringify(runtimeBrandPayload(loadBrandConfig(process.cwd(), resolveBrandId()))),
  },
  outfile: path.join(output, "scene.js"),
});
fs.writeFileSync(path.join(output, "index.html"), `<!doctype html><link rel="stylesheet" href="scene.css"><style>body{margin:0}#root{height:100vh}</style><div id="root"></div><script src="scene.js"></script>`);
fs.writeFileSync(path.join(output, "guest.html"), `<!doctype html><style>body{margin:0;background:#182338;color:white;font:24px system-ui}main{padding:50px}</style><main><h1>Slide 1</h1><input value="Preserved draft"></main><script>window.instance=crypto.randomUUID();window.escapes=0;addEventListener('keydown',e=>{if(e.key==='Escape')window.escapes++});</script>`);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "work-panel-fullscreen-"));
const env = { ...process.env, FULLSCREEN_SMOKE_PROFILE: profile, FULLSCREEN_SMOKE_OUTPUT: output };
delete env.ELECTRON_RUN_AS_NODE;
try {
  const child = spawn(require("electron"), ["qa/work-panel-fullscreen-smoke.cjs"], { env, stdio: "inherit" });
  process.exitCode = await new Promise((resolve, reject) => {
    child.on("exit", code => resolve(code ?? 1));
    child.on("error", reject);
  });
} finally {
  fs.rmSync(profile, { recursive: true, force: true });
}
