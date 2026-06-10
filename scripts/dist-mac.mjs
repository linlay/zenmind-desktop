import process from "node:process";
import { syncBrandArtifacts, resolveBrandId, electronBuilderConfigPath } from "./lib/brand-config.mjs";
import { npmCmd, runAndWait, withBrandEnv } from "./platform/spawn.mjs";

const projectRoot = process.cwd();
const brand = syncBrandArtifacts({ brandId: resolveBrandId() });
process.env.BRAND = brand.id;
const brandProcessOptions = (options = {}) => withBrandEnv(brand, options);

await runAndWait(npmCmd, ["run", "sync:version"], brandProcessOptions({ cwd: projectRoot }));
await runAndWait(npmCmd, ["run", "sync:env"], brandProcessOptions({ cwd: projectRoot }));
syncBrandArtifacts({ brandId: brand.id });
await runAndWait("node", ["./scripts/sync-builtin-assets.mjs", "--os=darwin", "--arch=arm64"], brandProcessOptions({ cwd: projectRoot }));
await runAndWait(npmCmd, ["run", "icons"], brandProcessOptions({ cwd: projectRoot }));
await runAndWait(npmCmd, ["run", "build"], brandProcessOptions({ cwd: projectRoot }));
await runAndWait(npmCmd, ["run", "stage:app", "--", "--os=darwin", "--arch=arm64"], brandProcessOptions({ cwd: projectRoot }));
await runAndWait(npmCmd, [
  "exec",
  "electron-builder",
  "--",
  "--config",
  electronBuilderConfigPath(projectRoot, brand.id),
  "--mac",
  "--arm64"
], brandProcessOptions({ cwd: projectRoot }));
