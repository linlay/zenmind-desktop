import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { brandBundleElectronDir, loadBrandConfig, resolveBrandId } from "../scripts/lib/brand-config.mjs";

const project = fileURLToPath(new URL("..", import.meta.url));
const bundle = brandBundleElectronDir(project, loadBrandConfig(project, resolveBrandId()));

for (const name of ["document-html-review.js", "work-panel-preview.js"]) {
  test(`development and packaged ${name} use the same sandbox-safe bundle`, () => {
    const development = fs.readFileSync(path.join(project, "dist-electron/preload", name), "utf8");
    assert.equal(development, fs.readFileSync(path.join(bundle, "preload", name), "utf8"));
    assert.doesNotMatch(development, /require\(["']\.{1,2}\//u, "sandbox preloads cannot load adjacent compiled modules");
  });
}
