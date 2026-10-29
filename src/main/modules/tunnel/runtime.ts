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
} from "../../../shared/contracts";
import { verifyDesktopAccessToken, type DesktopWsServerOptions } from "../desktop-protocol";
import {
  updateTunnelPlatformCredential, ensureTunnelHubRegistrationReady
} from "./registration";
import {
  clearLegacyTunnelHubSecrets,
  readTunnelHubSettings,
  readTunnelHubRegistrationBearerToken,
  saveTunnelHubSettings
} from "./settings";
import { TunnelClientEndpoint, type PlatformCredential } from "./client-endpoint";

type Logger = Pick<typeof console, "log" | "warn" | "error">;

type TunnelClientFactoryInput = {
  platformCredential: PlatformCredential;
  relayUrl: string;
  identityToken: string;
  deviceId: string;
  desktopWsServerOptions: DesktopWsServerOptions;
  tlsInsecureSkipVerify: boolean;
  logger: Logger;
};

type TunnelClient = {
  sessionId?: string;
  connect: () => Promise<void>;
  close: () => void;
  on: (event: "close" | "error", listener: (...args: any[]) => void) => unknown;
};

type TunnelHubRuntimeOptions = {
  app: App;
  desktopWsServerOptions: DesktopWsServerOptions;
  logger?: Logger;
  onConnected?: () => Promise<unknown> | unknown;
  onConnectionChanged?: () => void;
  createTunnelClient?: (input: TunnelClientFactoryInput) => TunnelClient;
  readNetworkSignature?: () => string;
  networkMonitorIntervalMs?: number;
  canUseDesktopSsoCredentials?: () => boolean;
};

const LOG_LIMIT_BYTES = 128 * 1024;
const LOG_PATH = "memory://desktop-tunnel-hub";
const DEFAULT_NETWORK_MONITOR_INTERVAL_MS = 5_000;
const MIN_NETWORK_MONITOR_INTERVAL_MS = 10;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

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
  private credentialRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private credentialExpiryTimer: ReturnType<typeof setTimeout> | null = null;
  private credentialSyncController: AbortController | null = null;
  private registrationController: AbortController | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private networkMonitorTimer: ReturnType<typeof setInterval> | null = null;
  private networkSignature = "";
  private client: TunnelClient | null = null;
  private startPromise: Promise<TunnelHubRuntimeCommandResult> | null = null;
  private stopping = false;
  private generation = 0;
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
      runtimeResult = await this.restart();
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
    const pending = this.startInternal(this.generation).finally(() => {
      if (this.startPromise === pending) this.startPromise = null;
    });
    this.startPromise = pending;
    return pending;
  }

  async stop(): Promise<TunnelHubRuntimeCommandResult> {
    this.generation += 1;
    this.registrationController?.abort();
    this.registrationController = null;
    this.startPromise = null;
    this.stopping = true;
    this.clearCredentialSync();
    this.clearReconnectTimer();
    this.stopNetworkMonitor();
    this.setPhase("stopping");
    const previousClient = this.client;
    this.client = null;
    previousClient?.close();
    this.stopping = false;
    this.lastError = "";
    const settings = readTunnelHubSettings(this.options.app);
    this.setPhase(settings.enabled ? "stopped" : "disabled");
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

  private canConnect() {
    return this.options.canUseDesktopSsoCredentials?.() !== false &&
      Boolean(readTunnelHubRegistrationBearerToken(this.options.app));
  }

  private async startInternal(generation: number): Promise<TunnelHubRuntimeCommandResult> {
    clearLegacyTunnelHubSecrets(this.options.app);
    const settings = readTunnelHubSettings(this.options.app);
    if (!settings.enabled || !this.canConnect()) {
      await this.stop();
      return this.commandResult(true, settings.enabled
        ? "Tunnel Hub is enabled and waiting for sign-in."
        : "Tunnel Hub is disabled.");
    }
    this.stopping = false;
    this.clearCredentialSync();
    this.clearReconnectTimer();
    this.startNetworkMonitor();
    const previousClient = this.client;
    this.client = null;
    previousClient?.close();
    this.lastError = "";
    this.setPhase("starting");
    try {
      const registration = new AbortController();
      this.registrationController = registration;
      let ready: Awaited<ReturnType<typeof ensureTunnelHubRegistrationReady>>;
      try {
        ready = await ensureTunnelHubRegistrationReady(this.options.app, registration.signal);
      } finally {
        if (this.registrationController === registration) this.registrationController = null;
      }
      if (generation !== this.generation) return this.commandResult(true, "Tunnel Hub start cancelled.");
      if (!this.canConnect()) {
        await this.stop();
        return this.commandResult(true, "Tunnel Hub is enabled and waiting for sign-in.");
      }
      this.setPhase(ready.registered ? "registered" : "connecting");
      if (!ready.identityToken) {
        throw new Error("Sign in before starting Tunnel Hub.");
      }
      const nextSettings = readTunnelHubSettings(this.options.app);
      const relayUrl = nextSettings.relayUrl;
      this.setPhase("connecting");
      const credential = await this.issuePlatformCredential();
      if (generation !== this.generation || !this.canConnect()) return this.commandResult(true, "Tunnel start superseded");
      await this.connectTunnel(relayUrl, readTunnelHubRegistrationBearerToken(this.options.app), nextSettings.deviceId, credential);
      if (generation === this.generation && this.client) this.scheduleCredentialRefresh(this.client, credential, generation);
      if (generation !== this.generation) return this.commandResult(true, "Tunnel Hub start cancelled.");
      if (!this.canConnect()) {
        await this.stop();
        return this.commandResult(true, "Tunnel Hub is enabled and waiting for sign-in.");
      }
      this.lastConnectedAt = new Date().toISOString();
      this.setPhase("connected");
      this.log(`connected relay=${relayUrl}`);
      void Promise.resolve(this.options.onConnected?.()).catch((error) => {
        this.options.logger?.warn?.(`[tunnel-hub] connected hook failed: ${messageFromError(error)}`);
      });
      return this.commandResult(true, "Tunnel Hub connected.");
    } catch (error) {
      if (generation !== this.generation) return this.commandResult(true, "Tunnel Hub start cancelled.");
      this.lastError = messageFromError(error);
      this.setPhase("error");
      this.log(`start failed: ${this.lastError}`);
      this.scheduleReconnect();
      return this.commandResult(false, this.lastError);
    }
  }

  private async connectTunnel(relayUrl: string, identityToken: string, deviceId: string, platformCredential: PlatformCredential) {
    const client = this.createTunnelClient({
      relayUrl,
      identityToken,
      deviceId,
      platformCredential,
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

  private async issuePlatformCredential(): Promise<PlatformCredential> {
    const options = this.options.desktopWsServerOptions;
    if (!options.issueAccessToken) throw new Error("Platform token issuer unavailable");
    const result = await options.issueAccessToken(this.options.app, "missing");
    if (!result.ok || !result.token) throw new Error("Platform token unavailable");
    const verify = options.verifyToken ?? ((token: string) =>
      verifyDesktopAccessToken(this.options.app, token, options.ensureIdentityCenterJwk));
    const auth = await verify(result.token);
    if (!auth.deviceId || auth.expiresAt <= Date.now()) throw new Error("Platform credential expired");
    return {
      token: result.token,
      platformDeviceId: auth.deviceId,
      expiresAt: new Date(auth.expiresAt).toISOString()
    };
  }

  private clearCredentialSync() {
    if (this.credentialRefreshTimer) clearTimeout(this.credentialRefreshTimer);
    if (this.credentialExpiryTimer) clearTimeout(this.credentialExpiryTimer);
    this.credentialRefreshTimer = null;
    this.credentialExpiryTimer = null;
    this.credentialSyncController?.abort();
    this.credentialSyncController = null;
  }

  private scheduleCredentialRefresh(
    client: TunnelClient, credential: PlatformCredential, generation: number
  ) {
    this.clearCredentialSync();
    const sessionId = client.sessionId;
    if (!sessionId) return;
    const controller = new AbortController();
    this.credentialSyncController = controller;
    const expiresAt = Date.parse(credential.expiresAt);
    const relayUrl = readTunnelHubSettings(this.options.app).relayUrl;
    const ownsSession = () => !controller.signal.aborted && generation === this.generation &&
      this.client === client && client.sessionId === sessionId;
    const current = () => ownsSession() &&
      this.canConnect() && relayUrl === readTunnelHubSettings(this.options.app).relayUrl;
    const expire = () => {
      if (!ownsSession()) return;
      if (Date.now() < expiresAt) return scheduleExpiry();
      this.clearCredentialSync();
      this.client = null;
      this.lastError = "Platform credential expired";
      this.log(this.lastError);
      client.close();
      this.scheduleReconnect();
    };
    const scheduleExpiry = () => {
      this.credentialExpiryTimer = setTimeout(expire,
        Math.max(0, Math.min(MAX_TIMER_DELAY_MS, expiresAt - Date.now())));
      this.credentialExpiryTimer.unref?.();
    };
    const scheduleRefresh = (refreshAt: number) => {
      this.credentialRefreshTimer = setTimeout(() => {
        if (!current()) return;
        this.credentialRefreshTimer = null;
        if (Date.now() < refreshAt) return scheduleRefresh(refreshAt);
        void refresh();
      }, Math.max(0, Math.min(MAX_TIMER_DELAY_MS, refreshAt - Date.now())));
      this.credentialRefreshTimer.unref?.();
    };
    const refresh = async () => {
      if (!current()) return;
      if (Date.now() >= expiresAt) return expire();
      try {
        const next = await this.issuePlatformCredential();
        if (!current()) return;
        if (Date.now() >= expiresAt) return expire();
        await updateTunnelPlatformCredential(this.options.app, sessionId, next, controller.signal);
        if (current()) {
          if (Date.now() >= expiresAt) return expire();
          if (this.lastError === "Platform credential synchronization failed") this.lastError = "";
          this.scheduleCredentialRefresh(client, next, generation);
        }
      } catch {
        if (!current()) return;
        if (Date.now() >= expiresAt) return expire();
        this.lastError = "Platform credential synchronization failed";
        this.log(this.lastError);
        scheduleRefresh(Date.now() + 5_000);
      }
    };
    // Only credentials acknowledged by the Hub may extend the session deadline.
    scheduleExpiry();
    scheduleRefresh(expiresAt - 50_000);
  }

  private createTunnelClient(input: TunnelClientFactoryInput) {
    return this.options.createTunnelClient?.(input) ?? new TunnelClientEndpoint(input);
  }

  private handleClientClosed(client: TunnelClient) {
    if (this.client === client) this.clearCredentialSync();
    if (this.client !== client) {
      return;
    }
    if (this.stopping) {
      return;
    }
    this.client = null;
    if (!readTunnelHubSettings(this.options.app).enabled) {
      this.setPhase("disabled");
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
    this.clearCredentialSync();
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
    this.clearCredentialSync();
    this.clearReconnectTimer();
    const settings = readTunnelHubSettings(this.options.app);
    if (!settings.enabled || this.stopping) {
      return;
    }
    if (!this.canConnect()) {
      void this.stop();
      return;
    }
    this.setPhase("reconnecting");
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
    const wasConnected = this.phase === "connected";
    this.phase = phase;
    this.log(`phase=${phase}`);
    if (wasConnected !== (phase === "connected")) {
      try {
        this.options.onConnectionChanged?.();
      } catch (error) {
        this.options.logger?.warn?.(`[tunnel-hub] connection notification failed: ${messageFromError(error)}`);
      }
    }
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
