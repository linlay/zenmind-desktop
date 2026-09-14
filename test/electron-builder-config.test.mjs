import test from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { loadBrandConfig } from "../scripts/lib/brand-model.mjs";
import { electronBuilderConfig } from "../scripts/lib/brand-packaging.mjs";

const require = createRequire(import.meta.url);
const { validateConfiguration } = require("app-builder-lib/out/util/config/config.js");
const rootDir = fileURLToPath(new URL("../", import.meta.url));

// Exercise the installed builder's validator to catch dependency conflicts and
// config schema changes before the release pipeline reaches packaging.
for (const brandId of ["zenmind", "cutej"]) {
  for (const target of [{ os: "darwin", arch: "arm64" }, { os: "win32", arch: "x64" }]) {
    test(`${brandId} ${target.os} config passes the installed electron-builder validator`, async () => {
      const config = electronBuilderConfig(loadBrandConfig(rootDir, brandId), target);
      await validateConfiguration(config, { isEnabled: false });
    });
  }
}
