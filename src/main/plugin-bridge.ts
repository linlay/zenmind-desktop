import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { App } from "electron";
import yaml from "js-yaml";
import type { DesktopPetTaskItem, ServiceState } from "../shared/contracts";
import type { ServiceDefinition } from "./manifest-utils";
import { getServiceConfigRoot, getServiceStateRoot } from "./user-paths";

const PLUGIN_BRIDGE_VERSION = "1";
const AGENT_PLATFORM_SERVICE_ID = "agent-platform";
const CODER_SETTINGS_RELATIVE_PATH = path.join("configs", "coder-settings.yml");
const OWNERSHIP_FILE_NAME = "plugin-bridge-acp-proxies.json";

type BridgeEnvelope = Record<string, unknown>;
type BridgeClient = {
  socket: net.Socket;
  authenticated: boolean;
  buffer: string;
};

type BridgeRecord = {
  service: ServiceDefinition;
  path: string;
  token: string;
  server: net.Server;
  clients: Set<BridgeClient>;
};

type PendingPluginEvent = {
  name: string;
  createdAt: string;
  data: unknown;
};

type PluginBridgeRequestContext = {
  sourcePluginId: string;
  method: string;
  params: unknown;
};

type PluginBridgeRequestResult = {
  ok: boolean;
  result?: unknown;
  error?: string;
};

type AcpProxyInput = {
  proxyId: string;
  baseUrl: string;
  timeoutMs: number;
};

type AgentPlatformQueryInput = {
  message: string;
  agentKey?: string;
  source?: string;
  action?: string;
};

const bridgeRecords = new Map<string, BridgeRecord>();
const latestServiceStates = new Map<string, ServiceState>();
const pendingPluginEvents = new Map<string, PendingPluginEvent[]>();
const MAX_PENDING_PLUGIN_EVENTS = 20;

let desktopReady = false;
let getServiceStateCallback: ((serviceId: string) => Promise<ServiceState>) | null = null;
let notifyAgentPlatformConfigChangedCallback: (() => void) | null = null;
let runDesktopPetBannerCallback: ((params: unknown) => unknown) | null = null;
let showSystemUpdateOverlayCallback: ((params: unknown) => unknown) | null = null;
let getAssistantActiveTasksCallback: (() => unknown) | null = null;
let updateDesktopActivityIslandCallback: ((params: unknown) => unknown) | null = null;
let hideDesktopActivityIslandCallback: ((params: unknown) => unknown) | null = null;
let updateDesktopCalendarOverlayCallback: ((params: unknown) => unknown) | null = null;
let hideDesktopCalendarOverlayCallback: ((params: unknown) => unknown) | null = null;
let readDesktopClipboardTextCallback: (() => unknown) | null = null;
let writeDesktopClipboardTextCallback: ((params: unknown) => unknown) | null = null;
let readDesktopClipboardContentCallback: (() => unknown) | null = null;
let writeDesktopClipboardContentCallback: ((params: unknown) => unknown) | null = null;
let registerDesktopClipboardShortcutCallback: ((pluginId: string, params: unknown) => unknown) | null = null;
let unregisterDesktopClipboardShortcutCallback: ((pluginId: string, params: unknown) => unknown) | null = null;
let showDesktopClipboardPaletteCallback: ((pluginId: string, params: unknown) => unknown) | null = null;
let hideDesktopClipboardPaletteCallback: ((pluginId: string, params: unknown) => unknown) | null = null;
let cleanupPluginBridgePluginCallback: ((pluginId: string) => void) | null = null;
let queryAgentPlatformCallback: ((params: AgentPlatformQueryInput) => unknown) | null = null;

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function asNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function hasPluginBridge(service: ServiceDefinition) {
  return service.kind === "plugin" && (
    service.hooks.subscribe.length > 0 ||
    service.bridge.requests.length > 0
  );
}

function hashPluginId(pluginId: string) {
  return crypto.createHash("sha1").update(pluginId).digest("hex").slice(0, 12);
}

function getTempPath(app: Pick<App, "getPath">) {
  try {
    return app.getPath("temp");
  } catch {
    return os.tmpdir();
  }
}

export function createPluginBridgePath(
  app: Pick<App, "getPath">,
  pluginId: string,
  options: { platform?: NodeJS.Platform; instanceId?: string } = {}
) {
  const platform = options.platform ?? process.platform;
  const instanceId = options.instanceId ?? `${process.pid}`;
  const pluginHash = hashPluginId(pluginId);

  if (platform === "win32") {
    return `\\\\.\\pipe\\Desktop.PluginBridge.${pluginHash}.${instanceId}`;
  }

  const socketName = `desktop-pb-${pluginHash}-${instanceId}.sock`;
  const preferredPath = path.join(getTempPath(app), socketName);
  // Darwin's sockaddr_un path is short (104 bytes). Test and user temp roots can
  // exceed it, so fall back to the OS temp root while retaining a unique name.
  if (Buffer.byteLength(preferredPath) < 100) {
    return preferredPath;
  }
  return path.join(os.tmpdir(), socketName);
}

function sendEnvelope(client: BridgeClient, envelope: BridgeEnvelope) {
  if (client.socket.destroyed) {
    return;
  }
  client.socket.write(`${JSON.stringify(envelope)}\n`);
}

function sendEvent(client: BridgeClient, name: string, data: unknown, createdAt = new Date().toISOString()) {
  sendEnvelope(client, {
    type: "event",
    name,
    createdAt,
    data
  });
}

function isHookSubscribed(service: ServiceDefinition, hookName: string) {
  return service.hooks.subscribe.includes(hookName);
}

function isRequestAllowed(service: ServiceDefinition, method: string) {
  return service.bridge.requests.includes(method);
}

function serviceStatusHookName(serviceId: string) {
  return `service.statusChanged:${serviceId}`;
}

function isTargetedPluginHook(name: string) {
  return name.startsWith("plugin.actionInvoked:");
}

function getTargetPluginIdForHook(name: string, data: unknown) {
  if (!isTargetedPluginHook(name)) {
    return "";
  }
  return asString(asObject(data).pluginId);
}

function queuePendingPluginEvent(pluginId: string, name: string, data: unknown) {
  const pending = pendingPluginEvents.get(pluginId) ?? [];
  pending.push({
    name,
    createdAt: new Date().toISOString(),
    data
  });
  pendingPluginEvents.set(pluginId, pending.slice(-MAX_PENDING_PLUGIN_EVENTS));
}

function flushPendingPluginEvents(record: BridgeRecord, client: BridgeClient) {
  const pending = pendingPluginEvents.get(record.service.id);
  if (!pending?.length) {
    return;
  }
  for (const event of pending) {
    if (isHookSubscribed(record.service, event.name)) {
      sendEvent(client, event.name, event.data, event.createdAt);
    }
  }
  pendingPluginEvents.delete(record.service.id);
}

function maybeSendInitialEvents(record: BridgeRecord, client: BridgeClient) {
  if (desktopReady && isHookSubscribed(record.service, "desktop.ready")) {
    sendEvent(client, "desktop.ready", {});
  }

  for (const hookName of record.service.hooks.subscribe) {
    if (!hookName.startsWith("service.statusChanged:")) {
      continue;
    }
    const serviceId = hookName.slice("service.statusChanged:".length);
    const state = latestServiceStates.get(serviceId);
    if (state) {
      sendEvent(client, hookName, { service: state });
    }
  }

  const agentPlatformState = latestServiceStates.get(AGENT_PLATFORM_SERVICE_ID);
  if (
    agentPlatformState?.status === "running" &&
    agentPlatformState.healthMeta.webUrl &&
    isHookSubscribed(record.service, "agentPlatform.ready")
  ) {
    sendEvent(client, "agentPlatform.ready", {
      webUrl: agentPlatformState.healthMeta.webUrl,
      port: agentPlatformState.healthMeta.port
    });
  }

  flushPendingPluginEvents(record, client);
}

function respondToRequest(client: BridgeClient, id: string, response: PluginBridgeRequestResult) {
  sendEnvelope(client, {
    type: "response",
    id,
    ok: response.ok,
    ...(response.result === undefined ? {} : { result: response.result }),
    ...(response.error === undefined ? {} : { error: response.error })
  });
}

function normalizeAcpProxyInput(params: unknown): AcpProxyInput {
  const record = asObject(params);
  const proxyId = asString(record.proxyId);
  const baseUrl = asString(record.baseUrl);
  const timeoutMs = asNumber(record.timeoutMs) ?? 300_000;
  if (!/^[a-z0-9][a-z0-9._-]*$/iu.test(proxyId)) {
    throw new Error("proxyId must be a non-empty identifier");
  }
  const parsed = new URL(baseUrl);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("baseUrl must be an HTTP URL");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("timeoutMs must be a positive integer");
  }
  return {
    proxyId,
    baseUrl: parsed.toString().replace(/\/$/u, ""),
    timeoutMs
  };
}

function readYamlObject(filePath: string) {
  if (!fs.existsSync(filePath)) {
    return {};
  }
  const parsed = yaml.load(fs.readFileSync(filePath, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${filePath} must contain a YAML object`);
  }
  return parsed as Record<string, unknown>;
}

function writeYamlObject(filePath: string, value: Record<string, unknown>) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, yaml.dump(value, { lineWidth: 120, noRefs: true }), "utf8");
}

function getAgentPlatformCoderSettingsPath(app: App) {
  return path.join(getServiceConfigRoot(app, AGENT_PLATFORM_SERVICE_ID, "builtin"), CODER_SETTINGS_RELATIVE_PATH);
}

function getPluginBridgeOwnershipPath(app: App, pluginId: string) {
  return path.join(getServiceStateRoot(app, pluginId, "plugin"), OWNERSHIP_FILE_NAME);
}

function readOwnership(app: App, pluginId: string) {
  const filePath = getPluginBridgeOwnershipPath(app, pluginId);
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as { acpProxies?: Record<string, { updatedAt: string }> };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { acpProxies: {} };
    }
    throw error;
  }
}

function writeOwnership(app: App, pluginId: string, ownership: { acpProxies?: Record<string, { updatedAt: string }> }) {
  const filePath = getPluginBridgeOwnershipPath(app, pluginId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify({ acpProxies: ownership.acpProxies ?? {} }, null, 2)}\n`, "utf8");
}

function ensureAcpProxies(config: Record<string, unknown>) {
  const existing = config["acp-proxies"];
  if (existing && typeof existing === "object" && !Array.isArray(existing)) {
    return existing as Record<string, unknown>;
  }
  const next: Record<string, unknown> = {};
  config["acp-proxies"] = next;
  return next;
}

function upsertAgentPlatformAcpProxy(app: App, sourcePluginId: string, params: unknown) {
  const input = normalizeAcpProxyInput(params);
  const configPath = getAgentPlatformCoderSettingsPath(app);
  const config = readYamlObject(configPath);
  const acpProxies = ensureAcpProxies(config);
  const nextEntry = {
    "base-url": input.baseUrl,
    "timeout-ms": input.timeoutMs
  };
  const changed = JSON.stringify(acpProxies[input.proxyId] ?? null) !== JSON.stringify(nextEntry);
  acpProxies[input.proxyId] = nextEntry;
  writeYamlObject(configPath, config);

  const ownership = readOwnership(app, sourcePluginId);
  ownership.acpProxies = {
    ...(ownership.acpProxies ?? {}),
    [input.proxyId]: { updatedAt: new Date().toISOString() }
  };
  writeOwnership(app, sourcePluginId, ownership);
  notifyAgentPlatformConfigChangedCallback?.();
  emitPluginBridgeHook("agentPlatform.configChanged", { sourcePluginId, proxyId: input.proxyId });
  return { changed, path: configPath };
}

function removeAgentPlatformAcpProxy(app: App, sourcePluginId: string, params: unknown) {
  const proxyId = asString(asObject(params).proxyId);
  if (!proxyId) {
    throw new Error("proxyId is required");
  }
  const ownership = readOwnership(app, sourcePluginId);
  if (!ownership.acpProxies?.[proxyId]) {
    return { changed: false, removed: false };
  }
  const configPath = getAgentPlatformCoderSettingsPath(app);
  const config = readYamlObject(configPath);
  const acpProxies = ensureAcpProxies(config);
  const hadProxy = Object.prototype.hasOwnProperty.call(acpProxies, proxyId);
  delete acpProxies[proxyId];
  delete ownership.acpProxies[proxyId];
  writeYamlObject(configPath, config);
  writeOwnership(app, sourcePluginId, ownership);
  notifyAgentPlatformConfigChangedCallback?.();
  emitPluginBridgeHook("agentPlatform.configChanged", { sourcePluginId, proxyId });
  return { changed: hadProxy, removed: hadProxy };
}

function normalizeAgentPlatformQueryInput(params: unknown): AgentPlatformQueryInput {
  const record = asObject(params);
  const message = asString(record.message);
  if (!message) {
    throw new Error("message is required");
  }
  const agentKey = asString(record.agentKey);
  const source = asString(record.source);
  const action = asString(record.action);
  return {
    message,
    ...(agentKey ? { agentKey } : {}),
    ...(source ? { source } : {}),
    ...(action ? { action } : {})
  };
}

const AGENT_PLATFORM_QUERY_TEXT_KEYS = [
  "text",
  "message",
  "content",
  "answer",
  "output",
  "finalMessage",
  "translation",
  "translatedText",
  "result",
  "response",
  "data"
];

function extractAgentPlatformQueryText(value: unknown, depth = 0): string {
  if (depth > 4) {
    return "";
  }
  if (typeof value === "string") {
    return value.trim();
  }
  if (!value || typeof value !== "object") {
    return "";
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const text = extractAgentPlatformQueryText(item, depth + 1);
      if (text) {
        return text;
      }
    }
    return "";
  }
  const record = value as Record<string, unknown>;
  for (const key of AGENT_PLATFORM_QUERY_TEXT_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      continue;
    }
    const text = extractAgentPlatformQueryText(record[key], depth + 1);
    if (text) {
      return text;
    }
  }
  return "";
}

function normalizeAgentPlatformQueryResult(raw: unknown) {
  return {
    text: extractAgentPlatformQueryText(raw),
    raw: raw ?? null
  };
}

async function handleBridgeRequest(
  app: App,
  context: PluginBridgeRequestContext
): Promise<PluginBridgeRequestResult> {
  try {
    if (context.method === "service.getStatus") {
      const serviceId = asString(asObject(context.params).serviceId);
      if (!serviceId) {
        throw new Error("serviceId is required");
      }
      const state = getServiceStateCallback
        ? await getServiceStateCallback(serviceId)
        : latestServiceStates.get(serviceId) ?? null;
      return { ok: true, result: { service: state } };
    }
    if (context.method === "agentPlatform.upsertAcpProxy") {
      return { ok: true, result: upsertAgentPlatformAcpProxy(app, context.sourcePluginId, context.params) };
    }
    if (context.method === "agentPlatform.removeAcpProxy") {
      return { ok: true, result: removeAgentPlatformAcpProxy(app, context.sourcePluginId, context.params) };
    }
    if (context.method === "agentPlatform.query") {
      if (!queryAgentPlatformCallback) {
        throw new Error("agent platform query bridge is unavailable");
      }
      const input = normalizeAgentPlatformQueryInput(context.params);
      return { ok: true, result: normalizeAgentPlatformQueryResult(await queryAgentPlatformCallback(input)) };
    }
    if (context.method === "desktopPet.runBanner") {
      if (!runDesktopPetBannerCallback) {
        throw new Error("desktop pet banner bridge is unavailable");
      }
      return { ok: true, result: runDesktopPetBannerCallback(context.params) };
    }
    if (context.method === "desktopOverlay.showSystemUpdate") {
      if (!showSystemUpdateOverlayCallback) {
        throw new Error("desktop overlay bridge is unavailable");
      }
      return { ok: true, result: showSystemUpdateOverlayCallback(context.params) };
    }
    if (context.method === "assistantRuns.getActiveTasks") {
      if (!getAssistantActiveTasksCallback) {
        throw new Error("assistant runs bridge is unavailable");
      }
      return { ok: true, result: getAssistantActiveTasksCallback() };
    }
    if (context.method === "desktopActivityIsland.update") {
      if (!updateDesktopActivityIslandCallback) {
        throw new Error("desktop activity island bridge is unavailable");
      }
      return { ok: true, result: updateDesktopActivityIslandCallback(context.params) };
    }
    if (context.method === "desktopActivityIsland.hide") {
      if (!hideDesktopActivityIslandCallback) {
        throw new Error("desktop activity island bridge is unavailable");
      }
      return { ok: true, result: hideDesktopActivityIslandCallback(context.params) };
    }
    if (context.method === "desktopCalendarOverlay.update") {
      if (!updateDesktopCalendarOverlayCallback) {
        throw new Error("desktop calendar overlay bridge is unavailable");
      }
      return { ok: true, result: updateDesktopCalendarOverlayCallback(context.params) };
    }
    if (context.method === "desktopCalendarOverlay.hide") {
      if (!hideDesktopCalendarOverlayCallback) {
        throw new Error("desktop calendar overlay bridge is unavailable");
      }
      return { ok: true, result: hideDesktopCalendarOverlayCallback(context.params) };
    }
    if (context.method === "desktopClipboard.readText") {
      if (!readDesktopClipboardTextCallback) {
        throw new Error("desktop clipboard bridge is unavailable");
      }
      return { ok: true, result: readDesktopClipboardTextCallback() };
    }
    if (context.method === "desktopClipboard.writeText") {
      if (!writeDesktopClipboardTextCallback) {
        throw new Error("desktop clipboard bridge is unavailable");
      }
      return { ok: true, result: writeDesktopClipboardTextCallback(context.params) };
    }
    if (context.method === "desktopClipboard.readContent") {
      if (!readDesktopClipboardContentCallback) {
        throw new Error("desktop clipboard content bridge is unavailable");
      }
      return { ok: true, result: readDesktopClipboardContentCallback() };
    }
    if (context.method === "desktopClipboard.writeContent") {
      if (!writeDesktopClipboardContentCallback) {
        throw new Error("desktop clipboard content bridge is unavailable");
      }
      return { ok: true, result: writeDesktopClipboardContentCallback(context.params) };
    }
    if (context.method === "desktopClipboard.registerShortcut") {
      if (!registerDesktopClipboardShortcutCallback) {
        throw new Error("desktop clipboard shortcut bridge is unavailable");
      }
      return { ok: true, result: registerDesktopClipboardShortcutCallback(context.sourcePluginId, context.params) };
    }
    if (context.method === "desktopClipboard.unregisterShortcut") {
      if (!unregisterDesktopClipboardShortcutCallback) {
        throw new Error("desktop clipboard shortcut bridge is unavailable");
      }
      return { ok: true, result: unregisterDesktopClipboardShortcutCallback(context.sourcePluginId, context.params) };
    }
    if (context.method === "desktopClipboard.showPalette") {
      if (!showDesktopClipboardPaletteCallback) {
        throw new Error("desktop clipboard palette bridge is unavailable");
      }
      return { ok: true, result: showDesktopClipboardPaletteCallback(context.sourcePluginId, context.params) };
    }
    if (context.method === "desktopClipboard.hidePalette") {
      if (!hideDesktopClipboardPaletteCallback) {
        throw new Error("desktop clipboard palette bridge is unavailable");
      }
      return { ok: true, result: hideDesktopClipboardPaletteCallback(context.sourcePluginId, context.params) };
    }
    throw new Error(`unsupported bridge request: ${context.method}`);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function handleAuthenticatedEnvelope(app: App, record: BridgeRecord, client: BridgeClient, envelope: BridgeEnvelope) {
  if (envelope.type !== "request") {
    return;
  }
  const id = asString(envelope.id);
  const method = asString(envelope.method);
  if (!id || !method) {
    return;
  }
  if (!isRequestAllowed(record.service, method)) {
    respondToRequest(client, id, { ok: false, error: `bridge request is not allowed: ${method}` });
    return;
  }
  void handleBridgeRequest(app, {
    sourcePluginId: record.service.id,
    method,
    params: envelope.params
  }).then((response) => respondToRequest(client, id, response));
}

function handleBridgeLine(app: App, record: BridgeRecord, client: BridgeClient, line: string) {
  let envelope: BridgeEnvelope;
  try {
    envelope = JSON.parse(line) as BridgeEnvelope;
  } catch {
    client.socket.destroy();
    return;
  }

  if (!client.authenticated) {
    if (
      envelope.type !== "hello" ||
      asString(envelope.pluginId) !== record.service.id ||
      asString(envelope.token) !== record.token ||
      String(envelope.protocolVersion || "") !== PLUGIN_BRIDGE_VERSION
    ) {
      client.socket.destroy();
      return;
    }
    client.authenticated = true;
    maybeSendInitialEvents(record, client);
    return;
  }

  handleAuthenticatedEnvelope(app, record, client, envelope);
}

function handleBridgeData(app: App, record: BridgeRecord, client: BridgeClient, chunk: Buffer) {
  client.buffer += chunk.toString("utf8");
  for (;;) {
    const lineEnd = client.buffer.indexOf("\n");
    if (lineEnd < 0) {
      break;
    }
    const line = client.buffer.slice(0, lineEnd).trim();
    client.buffer = client.buffer.slice(lineEnd + 1);
    if (line) {
      handleBridgeLine(app, record, client, line);
    }
  }
}

function createBridgeRecord(app: App, service: ServiceDefinition): BridgeRecord {
  const instanceId = crypto.randomBytes(4).toString("hex");
  const bridgePath = createPluginBridgePath(app, service.id, { instanceId });
  const token = crypto.randomBytes(24).toString("base64url");
  const clients = new Set<BridgeClient>();
  if (process.platform !== "win32") {
    fs.rmSync(bridgePath, { force: true });
  }
  const server = net.createServer((socket) => {
    const client: BridgeClient = { socket, authenticated: false, buffer: "" };
    clients.add(client);
    socket.on("data", (chunk) => handleBridgeData(app, record, client, chunk));
    socket.on("close", () => clients.delete(client));
    socket.on("error", () => clients.delete(client));
  });
  const record: BridgeRecord = {
    service,
    path: bridgePath,
    token,
    server,
    clients
  };
  server.listen(bridgePath);
  server.on("error", (error) => {
    console.warn(`[plugin-bridge] ${service.id} bridge failed: ${error instanceof Error ? error.message : String(error)}`);
  });
  return record;
}

export function configurePluginBridge(options: {
  getServiceState?: (serviceId: string) => Promise<ServiceState>;
  notifyAgentPlatformConfigChanged?: () => void;
  runDesktopPetBanner?: (params: unknown) => unknown;
  showSystemUpdateOverlay?: (params: unknown) => unknown;
  getAssistantActiveTasks?: () => unknown;
  updateDesktopActivityIsland?: (params: unknown) => unknown;
  hideDesktopActivityIsland?: (params: unknown) => unknown;
  updateDesktopCalendarOverlay?: (params: unknown) => unknown;
  hideDesktopCalendarOverlay?: (params: unknown) => unknown;
  readDesktopClipboardText?: () => unknown;
  writeDesktopClipboardText?: (params: unknown) => unknown;
  readDesktopClipboardContent?: () => unknown;
  writeDesktopClipboardContent?: (params: unknown) => unknown;
  registerDesktopClipboardShortcut?: (pluginId: string, params: unknown) => unknown;
  unregisterDesktopClipboardShortcut?: (pluginId: string, params: unknown) => unknown;
  showDesktopClipboardPalette?: (pluginId: string, params: unknown) => unknown;
  hideDesktopClipboardPalette?: (pluginId: string, params: unknown) => unknown;
  cleanupPluginBridgePlugin?: (pluginId: string) => void;
  queryAgentPlatform?: (params: AgentPlatformQueryInput) => unknown;
}) {
  getServiceStateCallback = options.getServiceState ?? null;
  notifyAgentPlatformConfigChangedCallback = options.notifyAgentPlatformConfigChanged ?? null;
  runDesktopPetBannerCallback = options.runDesktopPetBanner ?? null;
  showSystemUpdateOverlayCallback = options.showSystemUpdateOverlay ?? null;
  getAssistantActiveTasksCallback = options.getAssistantActiveTasks ?? null;
  updateDesktopActivityIslandCallback = options.updateDesktopActivityIsland ?? null;
  hideDesktopActivityIslandCallback = options.hideDesktopActivityIsland ?? null;
  updateDesktopCalendarOverlayCallback = options.updateDesktopCalendarOverlay ?? null;
  hideDesktopCalendarOverlayCallback = options.hideDesktopCalendarOverlay ?? null;
  readDesktopClipboardTextCallback = options.readDesktopClipboardText ?? null;
  writeDesktopClipboardTextCallback = options.writeDesktopClipboardText ?? null;
  readDesktopClipboardContentCallback = options.readDesktopClipboardContent ?? null;
  writeDesktopClipboardContentCallback = options.writeDesktopClipboardContent ?? null;
  registerDesktopClipboardShortcutCallback = options.registerDesktopClipboardShortcut ?? null;
  unregisterDesktopClipboardShortcutCallback = options.unregisterDesktopClipboardShortcut ?? null;
  showDesktopClipboardPaletteCallback = options.showDesktopClipboardPalette ?? null;
  hideDesktopClipboardPaletteCallback = options.hideDesktopClipboardPalette ?? null;
  cleanupPluginBridgePluginCallback = options.cleanupPluginBridgePlugin ?? null;
  queryAgentPlatformCallback = options.queryAgentPlatform ?? null;
}

export function getPluginBridgeEnv(app: App, service: ServiceDefinition): NodeJS.ProcessEnv {
  if (!hasPluginBridge(service)) {
    return {};
  }
  let record = bridgeRecords.get(service.id);
  if (!record) {
    record = createBridgeRecord(app, service);
    bridgeRecords.set(service.id, record);
  } else {
    record.service = service;
  }
  return {
    DESKTOP_PLUGIN_ID: service.id,
    DESKTOP_PLUGIN_BRIDGE_VERSION: PLUGIN_BRIDGE_VERSION,
    DESKTOP_PLUGIN_BRIDGE_PATH: record.path,
    DESKTOP_PLUGIN_BRIDGE_TOKEN: record.token
  };
}

export function emitPluginBridgeHook(name: string, data: unknown = {}) {
  const targetPluginId = getTargetPluginIdForHook(name, data);
  let delivered = false;
  let targetCanReceive = false;

  for (const record of bridgeRecords.values()) {
    if (targetPluginId && record.service.id !== targetPluginId) {
      continue;
    }
    if (!isHookSubscribed(record.service, name)) {
      continue;
    }
    targetCanReceive = true;
    for (const client of record.clients) {
      if (client.authenticated) {
        sendEvent(client, name, data);
        delivered = true;
      }
    }
  }

  if (targetPluginId && !delivered) {
    const targetRecord = bridgeRecords.get(targetPluginId);
    if (!targetRecord || targetCanReceive || isHookSubscribed(targetRecord.service, name)) {
      queuePendingPluginEvent(targetPluginId, name, data);
    }
  }
}

export function publishPluginBridgeServiceState(state: ServiceState) {
  latestServiceStates.set(state.id, state);
  emitPluginBridgeHook(serviceStatusHookName(state.id), { service: state });
  if (state.id !== AGENT_PLATFORM_SERVICE_ID) {
    return;
  }
  if (state.status === "running" && state.healthMeta.webUrl) {
    emitPluginBridgeHook("agentPlatform.ready", {
      webUrl: state.healthMeta.webUrl,
      port: state.healthMeta.port
    });
    return;
  }
  emitPluginBridgeHook("agentPlatform.stopped", { service: state });
}

export function publishPluginBridgeAssistantActiveTasks(tasks: DesktopPetTaskItem[], runningTaskCount: number) {
  emitPluginBridgeHook("assistant.activeTasksChanged", {
    tasks,
    runningTaskCount,
    updatedAt: new Date().toISOString()
  });
}

export function setPluginBridgeDesktopReady() {
  desktopReady = true;
  emitPluginBridgeHook("desktop.ready", {});
}

export function stopPluginBridgeServers() {
  for (const record of bridgeRecords.values()) {
    cleanupPluginBridgePluginCallback?.(record.service.id);
    for (const client of record.clients) {
      client.socket.destroy();
    }
    record.server.close();
    if (process.platform !== "win32") {
      fs.rmSync(record.path, { force: true });
    }
  }
  bridgeRecords.clear();
  pendingPluginEvents.clear();
}

export const __testInternals = {
  createPluginBridgePath,
  isHookSubscribed,
  isRequestAllowed,
  normalizeAcpProxyInput,
  upsertAgentPlatformAcpProxy,
  removeAgentPlatformAcpProxy,
  normalizeAgentPlatformQueryInput,
  extractAgentPlatformQueryText,
  normalizeAgentPlatformQueryResult
};
