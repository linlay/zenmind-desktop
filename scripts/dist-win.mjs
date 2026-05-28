import { isWindows } from "./platform/detect.mjs";

if (isWindows()) {
  const { buildOnWindowsHost } = await import("./platform/dist-win-host.mjs");
  await buildOnWindowsHost();
} else {
  const { buildWithDocker } = await import("./platform/dist-win-docker.mjs");
  await buildWithDocker();
}
