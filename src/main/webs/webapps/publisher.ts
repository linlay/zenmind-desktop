import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { App } from "electron";
import type {
  WebappEntry,
  WebappPublishInfo,
  WebappPublishInfoResult,
  WebappPublishResult,
  WebappPublishState,
  WebappRuntimeState
} from "../../../shared/contracts";
import { deriveTunnelHubRegistrationApiOrigin } from "../../tunnel-hub-registration";
import { getTunnelHubRuntimeStatus, startTunnelHubRuntime } from "../../tunnel-hub-runtime";
import {
  readTunnelHubRegistrationBearerToken,
  readTunnelHubSettings,
  saveTunnelHubSettings
} from "../../tunnel-hub-settings";
import { getDesktopWebappStateRoot } from "../../user-paths";
import { readWebappItems } from "./store";

const PUBLISH_STATE_FILE = "publish.json";
const PROVIDER = "tunnel" as const;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

type TunnelWebappResponse = {
  name?: unknown;
  publicHost?: unknown;
  publicUrl?: unknown;
  targetUrl?: unknown;
  routeId?: unknown;
  active?: unknown;
};

function nowIso() {
  return new Date().toISOString();
}

function readText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function findWebapp(app: App, id: string) {
  const normalizedId = id.trim();
  return readWebappItems(app).find((item) => item.id === normalizedId) ?? null;
}

function publishStatePath(app: App, id: string) {
  return path.join(getDesktopWebappStateRoot(app, id), PUBLISH_STATE_FILE);
}

function writePublishState(app: App, state: WebappPublishState) {
  const filePath = publishStatePath(app, state.id);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  fs.renameSync(temporaryPath, filePath);
}

export function readWebappPublishState(app: App, id: string): WebappPublishState | null {
  try {
    const value = JSON.parse(fs.readFileSync(publishStatePath(app, id), "utf8")) as Partial<WebappPublishState>;
    if (!value || value.id !== id || value.provider !== PROVIDER) {
      return null;
    }
    const active = value.active === true;
    return {
      id,
      provider: PROVIDER,
      status: value.status === "publishing" || value.status === "published" || value.status === "unpublished" || value.status === "error"
        ? value.status
        : active ? "published" : "ready",
      name: readText(value.name),
      routeId: readText(value.routeId),
      publicHost: readText(value.publicHost),
      url: readText(value.url),
      targetUrl: readText(value.targetUrl),
      active,
      message: readText(value.message),
      updatedAt: readText(value.updatedAt) || nowIso()
    };
  } catch {
    return null;
  }
}

function readRuntimeStatus() {
  try {
    return getTunnelHubRuntimeStatus();
  } catch {
    return null;
  }
}

function inspectPublishInfo(app: App): WebappPublishInfo {
  const settings = readTunnelHubSettings(app);
  const status = readRuntimeStatus();
  const signedIn = Boolean(readTunnelHubRegistrationBearerToken(app));
  return {
    provider: PROVIDER,
    configured: signedIn && settings.enabled && Boolean(settings.relayUrl) && Boolean(settings.deviceId),
    signedIn,
    tunnelEnabled: settings.enabled,
    tunnelConnected: status?.connected === true,
    deviceId: settings.deviceId,
    relayUrl: settings.relayUrl
  };
}

export async function getWebappPublishInfo(app: App, id: string): Promise<WebappPublishInfoResult> {
  const item = findWebapp(app, id);
  const info = inspectPublishInfo(app);
  const state = readWebappPublishState(app, id.trim());
  if (!item) {
    return { ok: false, info, state, message: "WebApp was not found." };
  }
  const message = !info.signedIn
    ? "Sign in before publishing through Tunnel Hub."
    : !info.tunnelEnabled
      ? "Enable Tunnel Hub before publishing."
      : !info.tunnelConnected
        ? "Tunnel Hub is not connected. Publishing will retry the connection."
        : "Ready to publish through Tunnel Hub.";
  return { ok: info.configured, info, state, message };
}

function stableWebappName(id: string) {
  const normalized = id
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  const base = normalized || `webapp-${crypto.createHash("sha256").update(id).digest("hex").slice(0, 12)}`;
  if (/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(base)) {
    return base;
  }
  const digest = crypto.createHash("sha256").update(base).digest("hex").slice(0, 8);
  return `${base.slice(0, 54).replace(/-+$/u, "")}-${digest}`;
}

function requireLoopbackTarget(targetUrl: string) {
  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch {
    throw new Error("WebApp runtime did not return a valid local URL.");
  }
  if (parsed.protocol !== "http:" || !LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new Error("Tunnel publishing only accepts a loopback HTTP WebApp target.");
  }
  parsed.username = "";
  parsed.password = "";
  parsed.hash = "";
  return parsed.toString();
}

async function registerTunnelRoute(app: App, item: WebappEntry, targetUrl: string, active: boolean) {
  const settings = readTunnelHubSettings(app);
  const siteToken = readTunnelHubRegistrationBearerToken(app);
  if (!siteToken) {
    throw new Error("Sign in before publishing through Tunnel Hub.");
  }
  if (!settings.enabled || !settings.relayUrl || !settings.deviceId) {
    throw new Error("Enable Tunnel Hub before publishing.");
  }
  const name = stableWebappName(item.id);
  const origin = deriveTunnelHubRegistrationApiOrigin(settings.relayUrl);
  const response = await fetch(
    `${origin}/api/desktop/devices/${encodeURIComponent(settings.deviceId)}/webapps/${encodeURIComponent(name)}`,
    {
      method: "PUT",
      headers: {
        "Authorization": `Bearer ${siteToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ targetUrl: requireLoopbackTarget(targetUrl), active }),
      signal: AbortSignal.timeout(30_000)
    }
  );
  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`Tunnel Hub WebApp registration failed (${response.status} ${response.statusText}): ${raw}`);
  }
  let data: TunnelWebappResponse;
  try {
    const parsed = JSON.parse(raw) as unknown;
    data = parsed && typeof parsed === "object" ? parsed as TunnelWebappResponse : {};
  } catch {
    throw new Error("Tunnel Hub returned an invalid WebApp registration response.");
  }
  const publicHost = readText(data.publicHost);
  const publicUrl = readText(data.publicUrl) || (publicHost ? `https://${publicHost}` : "");
  if (!readText(data.routeId) || !publicHost || !/^https:\/\//iu.test(publicUrl)) {
    throw new Error("Tunnel Hub did not return a complete WebApp route.");
  }
  return {
    name: readText(data.name) || name,
    routeId: readText(data.routeId),
    publicHost,
    url: publicUrl,
    targetUrl: readText(data.targetUrl) || requireLoopbackTarget(targetUrl),
    active: data.active === undefined ? active : data.active === true
  };
}

function createState(
  item: Pick<WebappEntry, "id">,
  values: Partial<Omit<WebappPublishState, "id" | "provider" | "updatedAt">>
): WebappPublishState {
  return {
    id: item.id,
    provider: PROVIDER,
    status: values.status ?? "ready",
    name: values.name ?? stableWebappName(item.id),
    routeId: values.routeId ?? "",
    publicHost: values.publicHost ?? "",
    url: values.url ?? "",
    targetUrl: values.targetUrl ?? "",
    active: values.active === true,
    message: values.message ?? "",
    updatedAt: nowIso()
  };
}

async function ensureTunnelConnected(app: App) {
  const current = readRuntimeStatus();
  if (current?.connected) {
    return current;
  }
  const result = await startTunnelHubRuntime();
  if (!result.ok || !result.status.connected) {
    throw new Error(result.message || "Tunnel Hub is not connected.");
  }
  return result.status;
}

function enableTunnelForPublish(app: App) {
  const settings = readTunnelHubSettings(app);
  if (settings.enabled) {
    return settings;
  }
  const result = saveTunnelHubSettings(app, { enabled: true });
  if (!result.ok || !result.settings.enabled) {
    throw new Error(result.message || "Tunnel Hub could not be enabled for publishing.");
  }
  return result.settings;
}

export async function publishWebapp(
  app: App,
  id: string,
  runtime: WebappRuntimeState | null
): Promise<WebappPublishResult> {
  const item = findWebapp(app, id);
  const info = inspectPublishInfo(app);
  if (!item) {
    const state = createState({ id: id.trim() }, { status: "error", message: "WebApp was not found." });
    return { ok: false, info, state, message: state.message };
  }
  const previous = readWebappPublishState(app, item.id);
  let state = createState(item, {
    ...previous,
    status: "publishing",
    active: previous?.active === true,
    targetUrl: runtime?.webUrl || previous?.targetUrl || "",
    message: "Publishing through Tunnel Hub..."
  });
  writePublishState(app, state);
  try {
    if (runtime?.status !== "running" || !runtime.webUrl) {
      throw new Error("Start the WebApp before publishing.");
    }
    enableTunnelForPublish(app);
    await ensureTunnelConnected(app);
    const route = await registerTunnelRoute(app, item, runtime.webUrl, true);
    state = createState(item, {
      status: "published",
      ...route,
      active: true,
      message: "Published through Tunnel Hub."
    });
    writePublishState(app, state);
    return { ok: true, info: inspectPublishInfo(app), state, message: state.message };
  } catch (error) {
    state = createState(item, {
      ...previous,
      status: "error",
      active: previous?.active === true,
      targetUrl: runtime?.webUrl || previous?.targetUrl || "",
      message: errorMessage(error)
    });
    writePublishState(app, state);
    return { ok: false, info: inspectPublishInfo(app), state, message: state.message };
  }
}

export async function unpublishWebapp(app: App, id: string): Promise<WebappPublishResult> {
  const item = findWebapp(app, id);
  const info = inspectPublishInfo(app);
  if (!item) {
    const state = createState({ id: id.trim() }, { status: "error", message: "WebApp was not found." });
    return { ok: false, info, state, message: state.message };
  }
  const previous = readWebappPublishState(app, item.id);
  if (!previous?.active) {
    const state = createState(item, { ...previous, status: "unpublished", active: false, message: "WebApp is not published." });
    writePublishState(app, state);
    return { ok: true, info, state, message: state.message };
  }
  try {
    const route = await registerTunnelRoute(app, item, previous.targetUrl, false);
    const state = createState(item, {
      status: "unpublished",
      ...route,
      active: false,
      message: "Tunnel publishing stopped."
    });
    writePublishState(app, state);
    return { ok: true, info: inspectPublishInfo(app), state, message: state.message };
  } catch (error) {
    const state = createState(item, {
      ...previous,
      status: "error",
      active: true,
      message: errorMessage(error)
    });
    writePublishState(app, state);
    return { ok: false, info: inspectPublishInfo(app), state, message: state.message };
  }
}

export async function syncPublishedWebappRoute(app: App, item: WebappEntry, runtime: WebappRuntimeState) {
  const previous = readWebappPublishState(app, item.id);
  if (!previous?.active || runtime.status !== "running" || !runtime.webUrl) {
    return previous;
  }
  try {
    await ensureTunnelConnected(app);
    const route = await registerTunnelRoute(app, item, runtime.webUrl, true);
    const state = createState(item, {
      status: "published",
      ...route,
      active: true,
      message: "Tunnel route synchronized."
    });
    writePublishState(app, state);
    return state;
  } catch (error) {
    const state = createState(item, {
      ...previous,
      status: "error",
      active: true,
      targetUrl: runtime.webUrl,
      message: `Tunnel route synchronization failed: ${errorMessage(error)}`
    });
    writePublishState(app, state);
    return state;
  }
}

export function listPublishedWebappIds(app: App) {
  return readWebappItems(app)
    .filter((item) => readWebappPublishState(app, item.id)?.active === true)
    .map((item) => item.id);
}

export const __testInternals = {
  stableWebappName,
  requireLoopbackTarget,
  registerTunnelRoute,
  enableTunnelForPublish
};
