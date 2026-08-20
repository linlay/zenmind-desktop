#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { generateWebappToolingBundle } from "./generate-webapp-tooling-bundle.mjs";

const projectRoot = process.cwd();
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-webapp-tooling-run-"));
const toolingPath = path.join(temporaryRoot, "webapp-tooling.mjs");

try {
  await generateWebappToolingBundle({ rootDir: projectRoot, outputPath: toolingPath });
  const result = spawnSync(process.execPath, [toolingPath, ...process.argv.slice(2)], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
    windowsHide: true
  });
  if (result.error) {
    throw result.error;
  }
  if (result.signal) {
    throw new Error(`WebApp Tooling terminated on signal ${result.signal}.`);
  }
  process.exitCode = result.status ?? 1;
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
