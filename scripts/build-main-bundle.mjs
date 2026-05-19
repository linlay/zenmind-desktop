import fs from "node:fs";
import path from "node:path";
import { builtinModules } from "node:module";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const projectRoot = process.cwd();
const srcRoot = path.join(projectRoot, "src");
const outputRoot = path.join(projectRoot, "build", "bundle", "dist-electron");

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
  const outdir = path.join(rootDir, "build", "bundle", "dist-electron");
  const rootSrc = path.join(rootDir, "src");

  fs.rmSync(outdir, { recursive: true, force: true });

  await build({
    absWorkingDir: rootDir,
    entryPoints: {
      "main/index": path.join(rootSrc, "main", "index.ts"),
      "main/attachment-worker": path.join(rootSrc, "main", "copilot", "attachments", "attachment-worker.ts"),
      "preload/index": path.join(rootSrc, "preload", "index.ts"),
      "preload/service-webview": path.join(rootSrc, "preload", "service-webview.ts")
    },
    outdir,
    platform: "node",
    format: "cjs",
    target: "node20",
    bundle: true,
    minify: true,
    sourcemap: false,
    legalComments: "none",
    external: getExternalModules(),
    loader: {
      ".node": "file"
    }
  });

  return outdir;
}

async function main() {
  const outdir = await buildMainBundle(projectRoot);
  console.log(`bundled electron runtime into ${path.relative(projectRoot, outdir)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
