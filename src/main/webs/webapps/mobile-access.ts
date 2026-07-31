import type { App } from "electron";
import type { WebappRuntimeState } from "../../../shared/contracts";
import { readTunnelHubSettings } from "../../tunnel-hub-settings";

function isMobileTunnelHost(hostname: string) {
  return /(?:^|\.)m\./iu.test(hostname.trim().toLowerCase());
}

function withMobileWebappPort(hostname: string, frontendPort: number) {
  const normalized = hostname.trim().toLowerCase();
  const markerIndex = normalized.indexOf(".m.");
  if (markerIndex <= 0 || normalized.slice(0, markerIndex).includes(".")) {
    return "";
  }
  return `${normalized.slice(0, markerIndex)}-${frontendPort}${normalized.slice(markerIndex)}`;
}

function readFrontendPortFromUrl(value: string) {
  try {
    const parsed = new URL(value);
    const port = Number.parseInt(parsed.port, 10);
    return Number.isInteger(port) && port > 0 && port <= 65535 ? port : 0;
  } catch {
    return 0;
  }
}

function readRuntimeFrontendPort(runtime: WebappRuntimeState | null) {
  if (runtime?.status !== "running") {
    return 0;
  }
  if (Number.isInteger(runtime.frontendPort) && (runtime.frontendPort ?? 0) > 0) {
    return runtime.frontendPort as number;
  }
  return readFrontendPortFromUrl(runtime.webUrl);
}

function createMobileTunnelWebappUrlForPort(app: App, frontendPort: number) {
  const settings = readTunnelHubSettings(app);
  if (!settings.publicUrl || !frontendPort) {
    return "";
  }
  try {
    const url = new URL(settings.publicUrl);
    if (url.protocol !== "https:" || !isMobileTunnelHost(url.hostname)) {
      return "";
    }
    const mobileWebappHost = withMobileWebappPort(url.hostname, frontendPort);
    if (!mobileWebappHost) {
      return "";
    }
    url.username = "";
    url.password = "";
    url.port = "";
    url.hostname = mobileWebappHost;
    url.pathname = "/";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

export function createMobileTunnelWebappUrl(app: App, runtime: WebappRuntimeState | null) {
  return createMobileTunnelWebappUrlForPort(app, readRuntimeFrontendPort(runtime));
}

export function createMobileTunnelWebappUrlFromTarget(app: App, targetUrl: string) {
  return createMobileTunnelWebappUrlForPort(app, readFrontendPortFromUrl(targetUrl));
}

export const __testInternals = {
  isMobileTunnelHost,
  withMobileWebappPort,
  readFrontendPortFromUrl,
  readRuntimeFrontendPort
};
