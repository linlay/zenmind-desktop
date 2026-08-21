#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const projectRoot = process.cwd();
export const WEBAPP_TOOLING_SOURCE_RELATIVE_PATH = "src/tooling/webapp-tooling.ts";

function parseOutputArg(argv) {
  const outputIndex = argv.indexOf("--output");
  if (outputIndex >= 0 && argv[outputIndex + 1]) {
    return path.resolve(argv[outputIndex + 1]);
  }
  return path.join(projectRoot, "output", "webapp-tooling.mjs");
}

export async function generateWebappToolingBundle({
  rootDir = projectRoot,
  outputPath = path.join(rootDir, "output", "webapp-tooling.mjs")
} = {}) {
  const absoluteOutputPath = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(absoluteOutputPath), { recursive: true });

  await build({
    entryPoints: [path.join(rootDir, ...WEBAPP_TOOLING_SOURCE_RELATIVE_PATH.split("/"))],
    outfile: absoluteOutputPath,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    legalComments: "none",
    banner: {
      js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);'
    }
  });
  fs.chmodSync(absoluteOutputPath, 0o755);
  return absoluteOutputPath;
}

async function main() {
  const outputPath = await generateWebappToolingBundle({
    rootDir: projectRoot,
    outputPath: parseOutputArg(process.argv.slice(2))
  });
  console.log(`generated standalone WebApp tooling at ${path.relative(projectRoot, outputPath)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
