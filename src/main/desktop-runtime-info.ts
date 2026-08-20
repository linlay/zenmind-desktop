import type { App } from "electron";
import type {
  DesktopAppInfo,
  DesktopDeviceInfo,
  DesktopRuntimeCredentialSummary,
  DesktopRuntimeDiagnostics,
  ServiceState
} from "../shared/contracts";
import { isEpochMilliseconds } from "../shared/time-contract";
import { getDesktopDeviceInfo } from "./desktop-device-info";
import { readDesktopSsoAccessToken } from "./oidc-sso";
import { listServices } from "./services/manager";
import { getDataRoot } from "./user-paths";

export type DesktopRuntimeDiagnosticsDependencies = {
  platform?: NodeJS.Platform;
  arch?: string;
  execPath?: string;
  electronVersion?: string;
  nodeVersion?: string;
  now?: () => number;
  getDeviceInfo?: (app: App, platform: NodeJS.Platform, arch: string) => DesktopDeviceInfo;
  getDataRoot?: (app: App, platform: NodeJS.Platform) => string;
  readDesktopSsoAccessToken?: (app: Pick<App, "getPath">) => string;
  listServices?: (app: App) => Promise<ServiceState[]>;
};

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const segments = token.split(".");
  if (segments.length !== 3 || !segments[1]) {
    return null;
  }
  try {
    const decoded = JSON.parse(Buffer.from(segments[1], "base64url").toString("utf8"));
    return decoded && typeof decoded === "object" && !Array.isArray(decoded)
      ? decoded as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export function summarizeDesktopSsoAccessToken(
  tokenValue: unknown,
  now: number = Date.now()
): DesktopRuntimeCredentialSummary {
  const token = typeof tokenValue === "string" ? tokenValue.trim() : "";
  if (!token) {
    return {
      present: false,
      expiresAt: null,
      expired: null,
      preview: ""
    };
  }

  const payload = decodeJwtPayload(token);
  const expiresAtCandidate = typeof payload?.exp === "number"
    ? payload.exp * 1_000
    : Number.NaN;
  const expiresAt = isEpochMilliseconds(expiresAtCandidate)
    ? expiresAtCandidate
    : null;

  return {
    present: true,
    expiresAt,
    expired: expiresAt === null ? null : expiresAt <= now,
    preview: token.length <= 4 ? "****" : `****${token.slice(-4)}`
  };
}

function mapDiagnosticService(service: ServiceState) {
  return {
    id: service.id,
    name: service.name,
    kind: service.kind,
    version: service.version,
    installed: service.installed,
    status: service.status,
    installDir: service.installDir,
    pid: service.healthMeta.pid,
    port: service.healthMeta.port,
    webUrl: service.healthMeta.webUrl
  };
}

export async function createDesktopRuntimeDiagnostics(
  app: App,
  appInfo: DesktopAppInfo,
  dependencies: DesktopRuntimeDiagnosticsDependencies = {}
): Promise<DesktopRuntimeDiagnostics> {
  const platform = dependencies.platform ?? process.platform;
  const arch = dependencies.arch?.trim() || process.arch;
  const deviceInfo = dependencies.getDeviceInfo
    ? dependencies.getDeviceInfo(app, platform, arch)
    : getDesktopDeviceInfo(app, { platform, arch });
  const dataRoot = dependencies.getDataRoot
    ? dependencies.getDataRoot(app, platform)
    : getDataRoot(app, platform);
  const token = (dependencies.readDesktopSsoAccessToken ?? readDesktopSsoAccessToken)(app);
  const services = await (dependencies.listServices ?? listServices)(app);

  return {
    app: { ...appInfo },
    device: {
      deviceId: deviceInfo.deviceId,
      deviceName: deviceInfo.deviceName,
      hostname: deviceInfo.hostname,
      username: deviceInfo.username,
      platform: deviceInfo.platform,
      arch: deviceInfo.arch
    },
    paths: {
      homeDir: app.getPath("home"),
      dataRoot,
      appPath: app.getAppPath(),
      execPath: dependencies.execPath ?? process.execPath
    },
    runtime: {
      electronVersion: dependencies.electronVersion ?? process.versions.electron ?? "",
      nodeVersion: dependencies.nodeVersion ?? process.versions.node,
      isPackaged: app.isPackaged
    },
    credentials: {
      desktopSso: summarizeDesktopSsoAccessToken(token, dependencies.now?.() ?? Date.now())
    },
    services: services.map(mapDiagnosticService)
  };
}
