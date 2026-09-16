import { net, webContents, type IpcMain, type IpcMainInvokeEvent, type WebContents } from "electron";
import { randomUUID } from "node:crypto";
import {
  CONNECTOR_AUTH_BROWSER_CHANNEL, CONNECTOR_AUTH_BROWSER_EVENT,
  CONNECTOR_AUTH_BROWSER_HOST_EVENT, CONNECTOR_AUTH_BROWSER_HOST_CLOSE,
  type ConnectorAuthBrowserDialog, type ConnectorAuthBrowserIdentity,
} from "../../../shared/contracts/agent-webclient-bridge";
import { registerIsolatedAuthGuest } from "../../infrastructure/electron/isolated-auth-guest";
import { CONNECTOR_AUTH_BROWSER_HOST_REQUEST } from "../../../shared/connector-auth-host";
import type { SurfaceContext } from "./ipc.shared";

type Dialog = { data: ConnectorAuthBrowserDialog; sender: WebContents; owner: WebContents; release(): void; cleanup(): void };

export function readConnectorAuthBrowserIdentity(value: unknown): ConnectorAuthBrowserIdentity {
  const input = value as ConnectorAuthBrowserIdentity | null;
  if (!input || typeof input.connectorId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(input.connectorId) ||
      typeof input.sessionId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(input.sessionId)) throw new Error("Invalid authorization identity");
  return { connectorId: input.connectorId, sessionId: input.sessionId };
}

export function readEmbeddedAuthorization(value: unknown, identity: ConnectorAuthBrowserIdentity, allowHostChoice = false): string {
  const data = value as Record<string, unknown> | null;
  if (!data || data.connectorId !== identity.connectorId || data.sessionId !== identity.sessionId || (!allowHostChoice && data.authBrowser !== "embedded") ||
      data.status !== "pending" || typeof data.expiresAt !== "string" || !(Date.parse(data.expiresAt) > Date.now()) ||
      typeof data.authorizationUrl !== "string" || data.authorizationUrl.length > 16384) throw new Error("Authorization session is not available");
  const url = new URL(data.authorizationUrl);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("Invalid authorization URL");
  return url.href;
}

export function registerConnectorAuthBrowser(ipc: IpcMain, options: {
  authorize(sender: WebContents): SurfaceContext;
  availability(): Promise<{ baseUrl: string; token: string }>;
  getMainWebContents?(): WebContents | null;
  subscribeLifecycle?(listener: () => void): () => unknown;
}) {
  const dialogs = new Map<number, Dialog>();
  const revisions = new Map<number, number>();
  const next = (sender: WebContents) => {
    const revision = (revisions.get(sender.id) || 0) + 1;
    revisions.set(sender.id, revision);
    return revision;
  };
  const dismiss = (dialog: Dialog, userClosed: boolean) => {
    if (dialogs.get(dialog.owner.id) !== dialog) return;
    dialogs.delete(dialog.owner.id);
    dialog.cleanup();
    dialog.release();
    if (!dialog.owner.isDestroyed()) dialog.owner.send(CONNECTOR_AUTH_BROWSER_HOST_EVENT, { dialogId: dialog.data.dialogId, closed: true });
    if (userClosed && !dialog.sender.isDestroyed()) dialog.sender.send(CONNECTOR_AUTH_BROWSER_EVENT, {
      connectorId: dialog.data.connectorId, sessionId: dialog.data.sessionId,
    });
  };
  const authorize = (sender: WebContents, host: boolean) => {
    if (!host) return options.authorize(sender);
    const owner = options.getMainWebContents?.();
    if (!owner || owner.isDestroyed() || owner !== sender) throw new Error("Untrusted Desktop authorization source");
    return { sender, target: { registrationId: `desktop:${owner.id}`, ownerWebContentsId: owner.id, currentUrl: owner.getURL() } };
  };
  const handle = async (event: IpcMainInvokeEvent, call: unknown, host: boolean) => {
    if (event.senderFrame !== event.sender.mainFrame) throw new Error("Untrusted authorization frame");
    const request = call as { action?: unknown; input?: unknown } | null;
    const identity = readConnectorAuthBrowserIdentity(request?.input);
    if (request?.action !== "open" && request?.action !== "close") throw new Error("Invalid authorization action");
    const revision = next(event.sender);
    if (request.action === "close") {
      // An established owner may release its dialog after its surface was unregistered.
      const current = [...dialogs.values()].find(dialog => dialog.sender === event.sender);
      if (current?.sender === event.sender && current.data.sessionId === identity.sessionId && current.data.connectorId === identity.connectorId) dismiss(current, false);
      return;
    }
    const context = authorize(event.sender, host);
    const ownerId = context.target.ownerWebContentsId;
    const { baseUrl, token } = await options.availability();
    const url = new URL("/api/admin/connectors/auth", baseUrl);
    url.searchParams.set("id", identity.connectorId);
    // Use Electron networking on macOS and Windows, matching the host's proxy settings.
    const response = await net.fetch(url.href, { headers: { Authorization: `Bearer ${token}` }, credentials: "omit", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error("Authorization status is unavailable");
    const result = await response.json() as { code?: number; data?: unknown };
    if (result.code !== 0) throw new Error("Authorization status is unavailable");
    const chosen = (request?.input as { browser?: unknown } | undefined)?.browser;
    if (chosen !== undefined && (!host || chosen !== "embedded")) throw new Error("Invalid authorization browser choice");
    const authorizationUrl = readEmbeddedAuthorization(result.data, identity, host && chosen === "embedded");
    const fresh = authorize(event.sender, host);
    if (revisions.get(event.sender.id) !== revision || fresh.target.registrationId !== context.target.registrationId ||
        fresh.target.ownerWebContentsId !== ownerId || fresh.target.currentUrl !== context.target.currentUrl) throw new Error("Authorization source changed");
    const owner = webContents.fromId(ownerId);
    if (!owner || owner.isDestroyed()) throw new Error("Authorization window is unavailable");
    const existing = dialogs.get(ownerId);
    if (existing) {
      if (existing.sender !== event.sender || existing.data.sessionId !== identity.sessionId || existing.data.connectorId !== identity.connectorId) throw new Error("Another authorization window is open");
      if (existing.data.url === authorizationUrl) return;
      // Keep the same browser session across CLI authorization steps.
      existing.release();
      existing.data.url = authorizationUrl;
      existing.release = registerIsolatedAuthGuest(existing.data.partition, ownerId, authorizationUrl);
      owner.send(CONNECTOR_AUTH_BROWSER_HOST_EVENT, existing.data);
      return;
    }
    const dialogId = randomUUID();
    const data = { ...identity, dialogId, url: authorizationUrl, partition: `connector-auth:${dialogId}` };
    const release = registerIsolatedAuthGuest(data.partition, ownerId, data.url);
    const sender = event.sender;
    const close = () => { next(sender); dismiss(dialog, false); };
    const navigation = (_event: unknown, url: string, inPlace: boolean, mainFrame: boolean) => {
      if (mainFrame && (!inPlace || (host && url !== context.target.currentUrl))) close();
    };
    const expiry = setTimeout(close, Math.max(1, Date.parse((result.data as { expiresAt: string }).expiresAt) - Date.now()));
    const unsubscribe = options.subscribeLifecycle?.(() => {
      try {
        const target = authorize(sender, host).target;
        if (target.registrationId !== context.target.registrationId || target.currentUrl !== context.target.currentUrl) close();
      } catch { close(); }
    });
    const dialog: Dialog = { data, sender, owner, release, cleanup: () => {
      clearTimeout(expiry);
      unsubscribe?.();
      sender.removeListener("destroyed", close);
      sender.removeListener("did-start-navigation", navigation);
      owner.removeListener("destroyed", close);
    } };
    dialogs.set(ownerId, dialog);
    sender.once("destroyed", close);
    sender.on("did-start-navigation", navigation);
    owner.once("destroyed", close);
    owner.send(CONNECTOR_AUTH_BROWSER_HOST_EVENT, data);
  };
  ipc.handle(CONNECTOR_AUTH_BROWSER_CHANNEL, (event, call) => handle(event, call, false));
  ipc.handle(CONNECTOR_AUTH_BROWSER_HOST_REQUEST, (event, call) => handle(event, call, true));
  ipc.handle(CONNECTOR_AUTH_BROWSER_HOST_CLOSE, (event: IpcMainInvokeEvent, dialogId: unknown) => {
    const dialog = dialogs.get(event.sender.id);
    if (event.senderFrame !== event.sender.mainFrame || !dialog || dialog.data.dialogId !== dialogId) throw new Error("Authorization window is unavailable");
    next(dialog.sender);
    dismiss(dialog, true);
  });
}
