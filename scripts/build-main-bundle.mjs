import { stageNpmRuntime } from "./stage-npm-runtime.mjs";
import { buildNodeLauncher } from "./build-node-launcher.mjs";
import fs from "node:fs";
import path from "node:path";
import { builtinModules } from "node:module";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { loadPlatformUpdateTrust } from "./lib/update-release.mjs";
import {
  brandBundleElectronDir,
  loadBrandConfig,
  resolveBrandId,
  runtimeBrandPayload
} from "./lib/brand-config.mjs";

const projectRoot = process.cwd();

function getExternalModules() {
  const builtins = new Set();
  for (const moduleName of builtinModules) {
    builtins.add(moduleName);
    builtins.add(`node:${moduleName}`);
  }

  return [
    "electron",
    "@napi-rs/canvas",
    "koffi",
    ...builtins
  ];
}

export async function buildMainBundle(rootDir = projectRoot) {
  await stageNpmRuntime(rootDir);
  await buildNodeLauncher(rootDir, { os: process.platform, arch: process.arch });
  const activeBrand = loadBrandConfig(rootDir, resolveBrandId());
  // Apple signing is independent of Windows Ed25519 configuration, including stale env vars.
  const updateTrust = loadPlatformUpdateTrust(rootDir, activeBrand.id, process.env.DESKTOP_UPDATE_TARGET_PLATFORM ?? process.platform);
  const outdir = brandBundleElectronDir(rootDir, activeBrand);
  const rootSrc = path.join(rootDir, "src");

  fs.rmSync(outdir, { recursive: true, force: true });

  await build({
    absWorkingDir: rootDir,
    entryPoints: {
      "main/index": path.join(rootSrc, "main", "index.ts"),
      "main/attachment-worker": path.join(rootSrc, "main", "modules", "assistant", "attachments", "attachment-worker.ts"),
      "main/conversation-html-worker": path.join(rootSrc, "main", "modules", "conversation-share", "html-worker.ts"),
      "main/webapp-tooling-worker": path.join(rootSrc, "main", "modules", "webs", "webapps", "tooling", "worker.ts"),
      "preload/plugin-window": path.join(rootSrc, "preload", "plugin-window.ts"),
      "preload/index": path.join(rootSrc, "preload", "index.ts"),
      "preload/service-webview": path.join(rootSrc, "preload", "service-webview.ts"),
      "preload/document-html-review": path.join(rootSrc, "preload", "document-html-review.ts"),
      "preload/work-panel-preview": path.join(rootSrc, "preload", "work-panel-preview.ts")
    },
    outdir,
    platform: "node",
    format: "cjs",
    target: "node20",
    bundle: true,
    minify: true,
    sourcemap: false,
    legalComments: "none",
    define: {
      __DESKTOP_APP_BRAND__: JSON.stringify(runtimeBrandPayload(activeBrand)),
      __DESKTOP_UPDATE_TRUST__: JSON.stringify(updateTrust)
    },
    external: getExternalModules(),
    loader: {
      ".node": "file"
    }
  });
  // Public-only build evidence used when signing the final installer manifest.
  fs.writeFileSync(path.join(outdir, "update-trust.json"), JSON.stringify(updateTrust) + "\n");

  // Development launches package.json's dist-electron Main, while packaged
  // apps use the brand bundle. Sandboxed preloads cannot require adjacent
  // TypeScript output, so both runtimes must consume the self-contained bundle.
  const developmentPreloadDir = path.join(rootDir, "dist-electron", "preload");
  fs.mkdirSync(developmentPreloadDir, { recursive: true });
  for (const name of ["document-html-review.js", "work-panel-preview.js", "plugin-window.js"]) {
    fs.copyFileSync(path.join(outdir, "preload", name), path.join(developmentPreloadDir, name));
  }

  const conversationWorker = path.join(outdir, "main", "conversation-html-worker.js");
  if (!fs.statSync(conversationWorker, { throwIfNoEntry: false })?.isFile()) {
    throw new Error("conversation HTML Worker bundle is missing");
  }
  const webappToolingWorker = path.join(outdir, "main", "webapp-tooling-worker.js");
  if (!fs.statSync(webappToolingWorker, { throwIfNoEntry: false })?.isFile()) {
    throw new Error("WebApp Tooling Worker bundle is missing");
  }
  // Dev Main is tsc output; give it the same application-relative Worker
  // entry as the packaged app. Never reuse another brand's staged app.
  const developmentMainDir = path.join(rootDir, "dist-electron", "main");
  fs.mkdirSync(developmentMainDir, { recursive: true });
  fs.copyFileSync(webappToolingWorker, path.join(developmentMainDir, "webapp-tooling-worker.js"));

  return outdir;
}

async function main() {
  const outdir = await buildMainBundle(projectRoot);
  console.log(`bundled electron runtime into ${path.relative(projectRoot, outdir)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
