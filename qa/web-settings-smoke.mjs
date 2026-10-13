// No real services, profile, packages, or network calls. Run from the repo root.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { loadBrandConfig, resolveBrandId, runtimeBrandPayload } from "../scripts/lib/brand-config.mjs";
const repo = process.cwd();
const require = createRequire(import.meta.url);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "web-settings-smoke-"));
await build({ entryPoints: [path.join(repo, "qa/web-settings-preview.tsx")], outfile: path.join(root, "preview.js"), bundle: true, jsx: "automatic", loader: { ".png": "dataurl", ".svg": "dataurl", ".jpg": "dataurl" }, define: { "process.env.NODE_ENV": '"production"', __DESKTOP_APP_BRAND__: JSON.stringify(runtimeBrandPayload(loadBrandConfig(repo, resolveBrandId()))) } });
// Measure settled surfaces consistently in a hidden window; motion is not under test.
fs.writeFileSync(path.join(root, "index.html"), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="preview.css"><style>body{margin:0}.app-shell{height:100vh;width:100vw}.app-main{padding:12px!important}.app-sidebar{padding:40px 8px 12px!important}.settings-page{--settings-content-max:100%}*,*::before,*::after{transition:none!important;animation:none!important}</style><div id="root"></div><script src="preview.js"></script>');
const env = { ...process.env, WEB_SETTINGS_PREVIEW_ROOT: root }; delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(require("electron"), [path.join(repo, "qa/web-settings-checks.cjs")], { env, stdio: "inherit" });
process.exitCode = await new Promise((resolve, reject) => { child.on("exit", (code, signal) => { if (signal) console.error(signal); resolve(code ?? 1); }); child.on("error", reject); });
if (!fs.existsSync(path.join(root, "report.json"))) { console.error("Preview exited before completing the checks."); process.exitCode = 1; }
console.log("Screenshots and report: " + root);
