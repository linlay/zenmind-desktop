import os from "node:os";
import type { App } from "electron";
import type {
  ServiceLogReadOptions,
  ServiceLogReadResult,
  TunnelHubSettings,
  TunnelHubSettingsInput,
  TunnelHubSettingsResult,
  TunnelHubRuntimeCommandResult,
  TunnelHubRuntimePhase,
  TunnelHubRuntimeStatus
} from "../shared/contracts";
import type { DesktopWsServerOptions } from "./desktop-ws-server";
import {
  ensureTunnelHubRegistrationReady
} from "./tunnel-hub-registration";
import {
  clearLegacyTunnelHubRegistrationToken,
  readTunnelHubSettings,
  readTunnelHubRelayToken,
  readTunnelHubRegistrationBearerToken,
  saveTunnelHubSettings
} from "./tunnel-hub-settings";
import { TunnelClientEndpoint } from "./tunnel-client-endpoint";

type Logger = Pick<typeof console, "log" | "warn" | "error">;

type TunnelClientFactoryInput = {
  relayUrl: string;
  relayToken: string;
  deviceId: string;
  desktopWsServerOptions: DesktopWsServerOptions;
  tlsInsecureSkipVerify: boolean;
  logger: Logger;
};

type TunnelClient = {
  connect: () => Promise<void>;
  close: () => void;
  on: (event: "close" | "error", listener: (...args: any[]) => void) => unknown;
};

type TunnelHubRuntimeOptions = {
  app: App;
  desktopWsServerOptions: DesktopWsServerOptions;
  logger?: Logger;
  onConnected?: () => Promise<unknown> | unknown;
  createTunnelClient?: (input: TunnelClientFactoryInput) => TunnelClient;
  readNetworkSignature?: () => string;
  networkMonitorIntervalMs?: number;
  canUseDesktopSsoCredentials?: () => boolean;
};

const LOG_LIMIT_BYTES = 128 * 1024;
const LOG_PATH = "memory://desktop-tunnel-hub";
const DEFAULT_NETWORK_MONITOR_INTERVAL_MS = 5_000;
const MIN_NETWORK_MONITOR_INTERVAL_MS = 10;

function buildNetworkInterfaceSignature(platformLabel: string, interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>) {
  const entries: string[] = [];
  for (const [name, items] of Object.entries(interfaces)) {
    for (const item of items ?? []) {
      if (item.internal || !item.address) {
        continue;
      }
      entries.push([
        platformLabel,
        name,
        item.family,
        item.address,
        item.cidr ?? "",
        item.mac,
        item.scopeid ?? ""
      ].join("|"));
    }
  }
  return entries.sort().join("\n");
}

function readCurrentNetworkSignature() {
  const interfaces = os.networkInterfaces();
  const isWindows = process.platform === "win32";
  const isMac = process.platform === "darwin";
  if (isWindows) {
    return buildNetworkInterfaceSignature("windows", interfaces);
  }
  if (isMac) {
    return buildNetworkInterfaceSignature("mac", interfaces);
  }
  return buildNetworkInterfaceSignature("other", interfaces);
}

function messageFromError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function readSettingsStatus(settings: TunnelHubSettings, phase: TunnelHubRuntimePhase, lastError = "", lastConnectedAt = ""): TunnelHubRuntimeStatus {
  const connected = phase === "connected";
  return {
    enabled: settings.enabled,
    running: connected || phase === "starting" || phase === "registered" || phase === "connecting" || phase === "reconnecting",
    connected,
    phase: settings.enabled ? phase : "disabled",
    deviceId: settings.deviceId,
    relayUrl: settings.relayUrl,
    publicHost: settings.publicHost,
    publicUrl: settings.publicUrl,
    webSocketUrl: settings.webSocketUrl,
    lastRegisteredAt: settings.lastRegisteredAt,
    lastConnectedAt: lastConnectedAt || undefined,
    lastError: lastError || undefined,
    reconnectSeconds: settings.reconnectSeconds
  };
}

export class TunnelHubRuntime {
  private phase: TunnelHubRuntimePhase = "disabled";
  private lastError = "";
  private lastConnectedAt = "";
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private networkMonitorTimer: ReturnType<typeof setInterval> | null = null;
  private networkSignature = "";
  private client: TunnelClient | null = null;
  private startPromise: Promise<TunnelHubRuntimeCommandResult> | null = null;
  private stopping = false;
  private logs = "";

  constructor(private readonly options: TunnelHubRuntimeOptions) {}

  getStatus() {
    return readSettingsStatus(readTunnelHubSettings(this.options.app), this.phase, this.lastError, this.lastConnectedAt);
  }

  async applySettings(input: TunnelHubSettingsInput): Promise<TunnelHubSettingsResult> {
    const result = saveTunnelHubSettings(this.options.app, input);
    if (!result.ok) {
      return {
        ...result,
        runtimeStatus: this.getStatus()
      };
    }
    let runtimeResult: TunnelHubRuntimeCommandResult | null = null;
    if (result.settings.enabled) {
      runtimeResult = await this.start();
    } else {
      runtimeResult = await this.stop();
    }
    return {
      ...result,
      ok: runtimeResult.ok,
      settings: readTunnelHubSettings(this.options.app),
      runtimeStatus: runtimeResult.status,
      message: runtimeResult.ok ? result.message : runtimeResult.message
    };
  }

  async start(): Promise<TunnelHubRuntimeCommandResult> {
    if (this.startPromise) {
      return this.startPromise;
    }
    this.startPromise = this.startInternal().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  async stop(): Promise<TunnelHubRuntimeCommandResult> {
    this.stopping = true;
    this.clearReconnectTimer();
    this.stopNetworkMonitor();
    this.setPhase("stopping");
    const previousClient = this.client;
    this.client = null;
    previousClient?.close();
    this.stopping = false;
    this.lastError = "";
    const settings = readTunnelHubSettings(this.options.app);
    this.phase = settings.enabled ? "stopped" : "disabled";
    this.log("stopped");
    return this.commandResult(true, "Tunnel Hub stopped.");
  }

  async restart(): Promise<TunnelHubRuntimeCommandResult> {
    await this.stop();
    return this.start();
  }

  async startIfEnabled() {
    if (!readTunnelHubSettings(this.options.app).enabled) {
      return this.getStatus();
    }
    return (await this.start()).status;
  }

  readLog(options: ServiceLogReadOptions = {}): ServiceLogReadResult {
    const content = this.logs;
    const totalBytes = Buffer.byteLength(content, "utf8");
    const limitBytes = Math.max(0, options.limitBytes ?? totalBytes);
    const beforeOffset = typeof options.beforeOffset === "number"
      ? Math.max(0, Math.min(options.beforeOffset, totalBytes))
      : totalBytes;
    const startOffset = Math.max(0, beforeOffset - limitBytes);
    return {
      ok: true,
      path: LOG_PATH,
      exists: true,
      content: content.slice(startOffset, beforeOffset),
      truncated: startOffset > 0,
      startOffset,
      endOffset: beforeOffset,
      hasPrevious: startOffset > 0,
      resetRequired: false,
      totalBytes
    };
  }

  private async startInternal(): Promise<TunnelHubRuntimeCommandResult> {
    clearLegacyTunnelHubRegistrationToken(this.options.app);
    if (this.options.canUseDesktopSsoCredentials?.() === false) {
      this.stopNetworkMonitor();
      this.phase = "stopped";
      return this.commandResult(false, "Desktop single sign-on is not ready.");
    }
    const settings = readTunnelHubSettings(this.options.app);
    if (!settings.enabled) {
      this.stopNetworkMonitor();
      this.phase = "disabled";
      const message = readTunnelHubRegistrationBearerToken(this.options.app)
        ? "Tunnel Hub is disabled or incomplete."
        : "Sign in before starting Tunnel Hub.";
      return this.commandResult(false, message);
    }
    this.stopping = false;
    this.clearReconnectTimer();
    this.startNetworkMonitor();
    const previousClient = this.client;
    this.client = null;
    previousClient?.close();
    this.lastError = "";
    this.setPhase("starting");
    try {
      const ready = await ensureTunnelHubRegistrationReady(this.options.app);
      this.setPhase(ready.registered ? "registered" : "connecting");
      if (!readTunnelHubRegistrationBearerToken(this.options.app)) {
        throw new Error("Sign in before starting Tunnel Hub.");
      }
      const nextSettings = readTunnelHubSettings(this.options.app);
      const token = readTunnelHubRelayToken(this.options.app);
      if (!token) {
        throw new Error("Tunnel Hub relay token is missing after registration.");
      }
      const relayUrl = nextSettings.relayUrl;
      this.setPhase("connecting");
      await this.connectTunnel(relayUrl, token, nextSettings.deviceId);
      this.lastConnectedAt = new Date().toISOString();
      this.setPhase("connected");
      this.log(`connected relay=${relayUrl}`);
      void Promise.resolve(this.options.onConnected?.()).catch((error) => {
        this.options.logger?.warn?.(`[tunnel-hub] connected hook failed: ${messageFromError(error)}`);
      });
      return this.commandResult(true, "Tunnel Hub connected.");
    } catch (error) {
      this.lastError = messageFromError(error);
      this.setPhase("error");
      this.log(`start failed: ${this.lastError}`);
      this.scheduleReconnect();
      return this.commandResult(false, this.lastError);
    }
  }

  private async connectTunnel(relayUrl: string, relayToken: string, deviceId: string) {
    const client = this.createTunnelClient({
      relayUrl,
      relayToken,
      deviceId,
      desktopWsServerOptions: this.options.desktopWsServerOptions,
      tlsInsecureSkipVerify: false,
      logger: this.options.logger ?? console
    });
    client.on("close", () => this.handleClientClosed(client));
    client.on("error", (error: unknown) => {
      if (this.client !== client) {
        return;
      }
      this.lastError = messageFromError(error);
      this.log(`connection error: ${this.lastError}`);
    });
    this.client = client;
    try {
      await client.connect();
    } catch (error) {
      if (this.client === client) {
        this.client = null;
      }
      throw error;
    }
    if (this.client !== client) {
      throw new Error("tunnel client closed during connect");
    }
  }

  private createTunnelClient(input: TunnelClientFactoryInput) {
    return this.options.createTunnelClient?.(input) ?? new TunnelClientEndpoint(input);
  }

  private handleClientClosed(client: TunnelClient) {
    if (this.client !== client) {
      return;
    }
    if (this.stopping) {
      return;
    }
    this.client = null;
    if (!readTunnelHubSettings(this.options.app).enabled) {
      this.phase = "disabled";
      return;
    }
    this.setPhase("reconnecting");
    this.log("connection closed; scheduling reconnect");
    this.scheduleReconnect();
  }

  private startNetworkMonitor() {
    this.networkSignature = this.readNetworkSignature();
    if (this.networkMonitorTimer) {
      return;
    }
    const requestedIntervalMs = Number(this.options.networkMonitorIntervalMs);
    const intervalMs = Math.max(
      MIN_NETWORK_MONITOR_INTERVAL_MS,
      Math.floor(Number.isFinite(requestedIntervalMs) ? requestedIntervalMs : DEFAULT_NETWORK_MONITOR_INTERVAL_MS)
    );
    this.networkMonitorTimer = setInterval(() => this.checkNetworkSignature(), intervalMs);
    this.networkMonitorTimer.unref?.();
  }

  private stopNetworkMonitor() {
    if (this.networkMonitorTimer) {
      clearInterval(this.networkMonitorTimer);
      this.networkMonitorTimer = null;
    }
    this.networkSignature = "";
  }

  private readNetworkSignature() {
    try {
      return this.options.readNetworkSignature?.() ?? readCurrentNetworkSignature();
    } catch (error) {
      this.options.logger?.warn?.(`[tunnel-hub] failed to read network state: ${messageFromError(error)}`);
      return this.networkSignature;
    }
  }

  private checkNetworkSignature() {
    if (this.stopping || !readTunnelHubSettings(this.options.app).enabled) {
      return;
    }
    const nextSignature = this.readNetworkSignature();
    if (nextSignature === this.networkSignature) {
      return;
    }
    this.networkSignature = nextSignature;
    this.handleNetworkChanged();
  }

  private handleNetworkChanged() {
    if (this.startPromise || this.stopping || !readTunnelHubSettings(this.options.app).enabled) {
      return;
    }
    if (!this.client && !this.reconnectTimer) {
      return;
    }
    this.log("network changed; reconnecting tunnel");
    this.clearReconnectTimer();
    const previousClient = this.client;
    this.client = null;
    this.setPhase("reconnecting");
    previousClient?.close();
    void this.start().catch((error) => {
      this.lastError = messageFromError(error);
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect() {
    this.clearReconnectTimer();
    const settings = readTunnelHubSettings(this.options.app);
    if (!settings.enabled || this.stopping) {
      return;
    }
    this.phase = "reconnecting";
    const delayMs = Math.max(1, settings.reconnectSeconds) * 1000;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.start().catch((error) => {
        this.lastError = messageFromError(error);
        this.scheduleReconnect();
      });
    }, delayMs);
  }

  private clearReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private commandResult(ok: boolean, message: string): TunnelHubRuntimeCommandResult {
    return {
      ok,
      message,
      status: this.getStatus(),
      settings: readTunnelHubSettings(this.options.app)
    };
  }

  private setPhase(phase: TunnelHubRuntimePhase) {
    this.phase = phase;
    this.log(`phase=${phase}`);
  }

  private log(message: string) {
    const line = `${new Date().toISOString()} ${message}\n`;
    this.logs = `${this.logs}${line}`;
    const bytes = Buffer.byteLength(this.logs, "utf8");
    if (bytes > LOG_LIMIT_BYTES) {
      this.logs = this.logs.slice(bytes - LOG_LIMIT_BYTES);
    }
    this.options.logger?.log?.(`[tunnel-hub] ${message}`);
  }
}

let runtime: TunnelHubRuntime | null = null;

export function configureTunnelHubRuntime(options: TunnelHubRuntimeOptions) {
  runtime = new TunnelHubRuntime(options);
  return runtime;
}

export function getTunnelHubRuntime() {
  if (!runtime) {
    throw new Error("Tunnel Hub runtime is not configured.");
  }
  return runtime;
}

export function getTunnelHubRuntimeStatus() {
  return getTunnelHubRuntime().getStatus();
}

export function startTunnelHubRuntime() {
  return getTunnelHubRuntime().start();
}

export function stopTunnelHubRuntime() {
  return getTunnelHubRuntime().stop();
}

export function restartTunnelHubRuntime() {
  return getTunnelHubRuntime().restart();
}

export function readTunnelHubRuntimeLog(options?: ServiceLogReadOptions) {
  return getTunnelHubRuntime().readLog(options);
}

export async function applyTunnelHubSettings(input: TunnelHubSettingsInput) {
  return getTunnelHubRuntime().applySettings(input);
}

export async function startTunnelHubRuntimeIfEnabled() {
  return getTunnelHubRuntime().startIfEnabled();
}
