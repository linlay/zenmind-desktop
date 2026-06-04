import process from "node:process";
import { syncBrandArtifacts, resolveBrandId, electronBuilderConfigPath } from "./lib/brand-config.mjs";
import { npmCmd, runAndWait } from "./platform/spawn.mjs";

const projectRoot = process.cwd();
const brand = syncBrandArtifacts({ brandId: resolveBrandId() });

await runAndWait(npmCmd, ["run", "sync:version"], { cwd: projectRoot });
await runAndWait(npmCmd, ["run", "sync:env"], { cwd: projectRoot });
syncBrandArtifacts({ brandId: brand.id });
await runAndWait("node", ["./scripts/sync-builtin-assets.mjs", "--os=darwin", "--arch=arm64"], { cwd: projectRoot });
await runAndWait(npmCmd, ["run", "icons"], { cwd: projectRoot });
await runAndWait(npmCmd, ["run", "build"], { cwd: projectRoot });
await runAndWait(npmCmd, ["run", "stage:app", "--", "--os=darwin", "--arch=arm64"], { cwd: projectRoot });
await runAndWait(npmCmd, [
  "exec",
  "electron-builder",
  "--",
  "--config",
  electronBuilderConfigPath(projectRoot, brand.id),
  "--mac",
  "--arm64"
], { cwd: projectRoot });
