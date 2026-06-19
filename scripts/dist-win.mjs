import process from "node:process";
import { isWindows } from "./platform/detect.mjs";
import { syncBrandArtifacts, resolveRequiredBrandId } from "./lib/brand-config.mjs";

const forceDocker = process.argv.includes("--docker");
const target = { os: "win32", arch: "x64" };
const brand = syncBrandArtifacts({ brandId: resolveRequiredBrandId(process.argv.slice(2), process.env, "dist:win"), target });
process.env.BRAND = brand.id;

if (isWindows() && !forceDocker) {
  const { buildOnWindowsHost } = await import("./platform/dist-win-host.mjs");
  await buildOnWindowsHost(brand);
} else {
  const { buildWithDocker } = await import("./platform/dist-win-docker.mjs");
  await buildWithDocker(brand);
}
