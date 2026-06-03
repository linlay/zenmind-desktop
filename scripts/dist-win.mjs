import { isWindows } from "./platform/detect.mjs";
import { syncBrandArtifacts, resolveBrandId } from "./lib/brand-config.mjs";

const forceDocker = process.argv.includes("--docker");
const brand = syncBrandArtifacts({ brandId: resolveBrandId() });

if (isWindows() && !forceDocker) {
  const { buildOnWindowsHost } = await import("./platform/dist-win-host.mjs");
  await buildOnWindowsHost(brand);
} else {
  const { buildWithDocker } = await import("./platform/dist-win-docker.mjs");
  await buildWithDocker(brand);
}
