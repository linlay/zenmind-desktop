import type { App } from "electron";
import type { WebappRuntimeState } from "../../../shared/contracts";
import { readTunnelHubSettings } from "../../tunnel-hub-settings";

function isMobileTunnelHost(hostname: string) {
  return /(?:^|\.)m\./iu.test(hostname.trim().toLowerCase());
}

function readRuntimeFrontendPort(runtime: WebappRuntimeState | null) {
  if (runtime?.status !== "running") {
    return 0;
  }
  if (Number.isInteger(runtime.frontendPort) && (runtime.frontendPort ?? 0) > 0) {
    return runtime.frontendPort as number;
  }
  try {
    const parsed = new URL(runtime.webUrl);
    const port = Number.parseInt(parsed.port, 10);
    return Number.isInteger(port) && port > 0 && port <= 65535 ? port : 0;
  } catch {
    return 0;
  }
}

export function createMobileTunnelWebappUrl(app: App, runtime: WebappRuntimeState | null) {
  const settings = readTunnelHubSettings(app);
  const frontendPort = readRuntimeFrontendPort(runtime);
  if (!settings.publicUrl || !frontendPort) {
    return "";
  }
  try {
    const url = new URL(settings.publicUrl);
    if (url.protocol !== "https:" || !isMobileTunnelHost(url.hostname)) {
      return "";
    }
    url.username = "";
    url.password = "";
    url.port = "";
    url.pathname = `/webapps/${frontendPort}/`;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

export const __testInternals = {
  isMobileTunnelHost,
  readRuntimeFrontendPort
};
