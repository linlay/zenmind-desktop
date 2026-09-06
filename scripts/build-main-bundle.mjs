import fs from "node:fs";
import path from "node:path";
import { builtinModules } from "node:module";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
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
    ...builtins
  ];
}

export async function buildMainBundle(rootDir = projectRoot) {
  const activeBrand = loadBrandConfig(rootDir, resolveBrandId());
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
      "preload/index": path.join(rootSrc, "preload", "index.ts"),
      "preload/service-webview": path.join(rootSrc, "preload", "service-webview.ts"),
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
      __DESKTOP_APP_BRAND__: JSON.stringify(runtimeBrandPayload(activeBrand))
    },
    external: getExternalModules(),
    loader: {
      ".node": "file"
    }
  });

  const conversationWorker = path.join(outdir, "main", "conversation-html-worker.js");
  if (!fs.statSync(conversationWorker, { throwIfNoEntry: false })?.isFile()) {
    throw new Error("conversation HTML Worker bundle is missing");
  }
  const webappToolingWorker = path.join(outdir, "main", "webapp-tooling-worker.js");
  if (!fs.statSync(webappToolingWorker, { throwIfNoEntry: false })?.isFile()) {
    throw new Error("WebApp Tooling Worker bundle is missing");
  }

  return outdir;
}

async function main() {
  const outdir = await buildMainBundle(projectRoot);
  console.log(`bundled electron runtime into ${path.relative(projectRoot, outdir)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
