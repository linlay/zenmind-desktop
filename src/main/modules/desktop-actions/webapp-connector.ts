import { getWebappAuthenticationConnectors } from "../../../shared/webapp-bridge";
import { hasWebappPermission, executionPermissionKey, requestWebappPermission, requireWebappPermission } from "./webapp-permissions";
import { ConnectorError, platform, request, captureWebappContext } from "./webapp-platform-client";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID as artifactRequestId } from "node:crypto";
import { artifactRelativePath } from "../artifacts";
import { t } from "../../support/i18n/main-i18n";
import { BrowserWindow, dialog, shell } from "electron";
import { randomUUID } from "node:crypto";
import type { DesktopActionBridgeOptions, DesktopActionInvocationContext } from "./runtime.part-1";
import { configureIsolatedAuthGuest, registerIsolatedAuthGuest } from "../../infrastructure/electron/isolated-auth-guest";
import { readEmbeddedAuthorization } from "../agent-platform";

const actions = new Set(["connector.list", "connector.describe", "connector.invoke", "desktop.authenticateConnector", "desktop.requestAccess", "artifact.list", "artifact.get", "artifact.read", "artifact.open", "artifact.saveAs", "skill.list", "skill.describe"]);
export const isWebappConnectorAction = (action: string) => actions.has(action);
type Session = { sessionId: string; connectorId: string; status: string; expiresAt: string; authBrowser?: string; authorizationUrl?: string };
type AuthResult = { status: "authorized" | "cancelled" | "failed" };
type SharedLogin = { promise: Promise<AuthResult>; waiters: number; abort: AbortController };
const logins = new Map<string, SharedLogin>();
const applicationChats = new Map<string, Set<string>>();
export function rememberWebappChat(key: string, chatId: string) {
  if (!applicationChats.has(key)) { if (applicationChats.size >= 1024) throw new ConnectorError("app_capacity_exceeded"); applicationChats.set(key, new Set()); }
  const chats = applicationChats.get(key)!;
  if (chats.size >= 1024) chats.delete(chats.values().next().value!);
  chats.add(chatId);
}

function declared(options: DesktopActionBridgeOptions, appId: string) {
  const item = options.webs.webappManager.list(options.app).find(value => value.id === appId);
  if (!item) throw new ConnectorError("app_grant_required");
  return item.desktopBridge?.version === 2 ? item.desktopBridge.connectorExecution ?? [] : [];
}
async function wait(ms: number, signal: AbortSignal) {
  if (signal.aborted) return;
  await new Promise<void>(resolve => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
    const timer = setTimeout(finish, ms); signal.addEventListener("abort", finish, { once: true });
  });
}
async function authenticate(options: DesktopActionBridgeOptions, identity: Awaited<ReturnType<typeof platform>>, connectorId: string, signal: AbortSignal): Promise<AuthResult> {
  const authPath = `/api/desktop/connector/auth?id=${encodeURIComponent(connectorId)}`;
  let window: BrowserWindow | undefined; let release: (() => void) | undefined; let partition = ""; let currentURL = "";
  const owner = options.getMainWindow();
  if (!owner || owner.isDestroyed()) return { status: "failed" };
  try {
    // The host confirmation is the trusted user gesture. A forged gateway POST
    // cannot silently open an account login or authenticate on the user's behalf.
    const choice = await dialog.showMessageBox(owner, { type: "question", message: t("webapp.connector.signIn", { connectorId }), detail: t("webapp.connector.signInDetail"), buttons: [t("webapp.connector.signInButton"), t("common.cancel")], defaultId: 0, cancelId: 1 });
    if (choice.response !== 0 || signal.aborted) return { status: "cancelled" };
    if ((await platform(options)).subject !== identity.subject) return { status: "cancelled" };
    const status = await request(identity.baseUrl, identity.token, authPath, "GET", undefined, false, signal);
    if (status.status === "authorized") return { status: "authorized" };
    const started: Session = await request(identity.baseUrl, identity.token, authPath, "POST", undefined, false, signal);
    if (!started?.sessionId || started.connectorId !== connectorId) return { status: "failed" };
    const deadline = Math.min(Date.parse(started.expiresAt), Date.now() + 15 * 60_000);
    if (!Number.isFinite(deadline)) return { status: "failed" };
    let userClosed = false;
    while (!signal.aborted && !userClosed && !owner.isDestroyed() && Date.now() < deadline) {
      const current = await platform(options);
      if (current.subject !== identity.subject || current.baseUrl !== identity.baseUrl) return { status: "cancelled" };
      const session: Session = await request(identity.baseUrl, current.token, `${authPath}&sessionId=${encodeURIComponent(started.sessionId)}`, "GET", undefined, false, signal);
      if (session.sessionId !== started.sessionId || session.connectorId !== connectorId) return { status: "failed" };
      if (session.status === "authorized") return { status: "authorized" };
      if (["failed", "canceled", "expired"].includes(session.status)) return { status: session.status === "failed" ? "failed" : "cancelled" };
      if (session.status === "pending" && session.authorizationUrl) {
        if (session.authBrowser !== "embedded" && session.authBrowser !== "system") return { status: "failed" };
        const url = readEmbeddedAuthorization({ ...session, authBrowser: "embedded" }, { connectorId, sessionId: session.sessionId });
        if (session.authBrowser === "system") {
          if (url !== currentURL) { await shell.openExternal(url); currentURL = url; }
          await wait(750, signal); continue;
        }
        if (url !== currentURL) {
          if (!window) {
            partition = `connector-auth:${randomUUID()}`;
            release = registerIsolatedAuthGuest(partition, owner.webContents.id, url);
            window = new BrowserWindow({ parent: owner, width: 720, height: 760, title: t("webapp.connector.signIn", { connectorId }), webPreferences: { partition, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true } });
            configureIsolatedAuthGuest(window.webContents);
            window.on("closed", () => { userClosed = true; });
          }
          currentURL = url;
          await window.loadURL(url);
        }
      }
      await wait(750, signal);
    }
    return { status: "cancelled" };
  } catch { return { status: "failed" }; }
  finally {
    // Releasing a waiter/window is not cancellation of a Platform session that
    // another application or trusted WebClient may still be using.
    if (window && !window.isDestroyed()) window.destroy(); release?.();
  }
}

export async function executeWebappConnector(options: DesktopActionBridgeOptions, action: string, args: Record<string, unknown>, invocation: DesktopActionInvocationContext) {
  try {
    if (invocation.kind !== "webappPage" && invocation.kind !== "webappBackend") throw new ConnectorError("forbidden");
    const context = await captureWebappContext(options, invocation.webappId, invocation.signal);
    if (action === "desktop.requestAccess") {
      if (Object.keys(args).some(key => !["capability", "connectorId", "adapter"].includes(key)) || typeof args.capability !== "string") throw new ConnectorError("invalid_arguments");
      return { ok: true, action, result: await requestWebappPermission(options, context, invocation, args.capability, typeof args.connectorId === "string" ? args.connectorId : undefined, typeof args.adapter === "string" ? args.adapter : undefined) };
    }
    if (action.startsWith("artifact.") || action.startsWith("skill.")) {
      if ((action === "artifact.open" || action === "artifact.saveAs") && invocation.kind !== "webappPage") throw new ConnectorError("forbidden");
      const result = await executeWebappRead(options, action, args, context);
      await context.check();
      return result;
    }
    if ("operationId" in args) throw new ConnectorError("connector_contract_upgrade_required");
    const execution = declared(options, invocation.webappId);
    const allowed = action === "connector.list" ? [] : action === "connector.invoke" ? ["connectorId", "adapter", "args", "component", "toolName", "arguments", "idempotencyKey", "credentialRevision"] : ["connectorId"];
    if (Object.keys(args).some(key => !allowed.includes(key))) throw new ConnectorError("invalid_arguments");
    const connectorId = args.connectorId;
    if (action !== "connector.list" && action !== "desktop.authenticateConnector" && (typeof connectorId !== "string" || !execution.some(p => p.connectorId === connectorId))) throw new ConnectorError("operation_not_allowed");
    const identity = context;
    if (action === "desktop.authenticateConnector") {
      if (typeof connectorId !== "string" || !getWebappAuthenticationConnectors(context.item.desktopBridge).includes(connectorId)) throw new ConnectorError("operation_not_allowed");
      if (invocation.kind !== "webappPage") throw new ConnectorError("forbidden");
      const key = `${identity.baseUrl}\0${identity.subject}\0${connectorId}`;
      let shared = logins.get(key);
      if (!shared) {
        if (logins.size >= 16) throw new ConnectorError("connector_busy");
        const abort = new AbortController();
        shared = { abort, waiters: 0, promise: authenticate(options, identity, connectorId as string, abort.signal).finally(() => { logins.delete(key); }) };
        logins.set(key, shared);
      }
      shared.waiters++;
      try {
        const waiter = new AbortController();
        const observe = async (): Promise<AuthResult> => {
          while (!waiter.signal.aborted) {
            await wait(750, waiter.signal);
            if (waiter.signal.aborted) break;
            try {
              await context.check();
              const active = options.webs.webappRuntime.getStatus(options.app, invocation.webappId);
              if (active?.status !== "running" || (await platform(options)).subject !== identity.subject) return { status: "cancelled" };
            } catch { return { status: "cancelled" }; }
          }
          return { status: "cancelled" };
        };
        let result: AuthResult;
        try { result = await Promise.race([shared.promise, observe()]); } finally { waiter.abort(); }
        if (result.status === "cancelled") return { ok: true, action, result };
        await context.check();
        const fresh = await platform(options);
        if (fresh.subject !== identity.subject) return { ok: true, action, result: { status: "cancelled" } };
        return { ok: true, action, result };
      } finally { shared.waiters--; if (!shared.waiters) shared.abort.abort(); }
    }
    if (invocation.kind !== "webappPage") throw new ConnectorError("forbidden");
    const granted = execution.filter(p => hasWebappPermission(context, executionPermissionKey(p.connectorId,p.adapter)));
    if (action === "connector.invoke") {
      if (args.credentialRevision !== undefined && (typeof args.credentialRevision !== "string" || !args.credentialRevision || args.credentialRevision.length > 256)) throw new ConnectorError("invalid_arguments");
      if (args.idempotencyKey !== undefined && (typeof args.idempotencyKey !== "string" || !/^[a-zA-Z0-9._:-]{8,128}$/u.test(args.idempotencyKey))) throw new ConnectorError("invalid_arguments");
      if (!execution.some(p => p.connectorId === connectorId && p.adapter === args.adapter)) throw new ConnectorError("connector_execution_not_allowed");
      if (args.adapter === "cli") {
        if (!Array.isArray(args.args) || args.args.length > 256 || args.args.some(v => typeof v !== "string" || v.includes("\0")) || ["component","toolName","arguments"].some(k => k in args)) throw new ConnectorError("invalid_arguments");
      } else if (args.adapter === "mcp") {
        if ("args" in args || typeof args.component !== "string" || !args.component || typeof args.toolName !== "string" || !args.toolName || !args.arguments || typeof args.arguments !== "object" || Array.isArray(args.arguments)) throw new ConnectorError("invalid_arguments");
      } else throw new ConnectorError("invalid_arguments");
      requireWebappPermission(context, executionPermissionKey(connectorId as string,args.adapter as string));
    }
    if (action === "connector.describe" && !granted.some(p => p.connectorId === connectorId)) throw new ConnectorError("app_permission_required");
    const grant = await request(identity.baseUrl, identity.token, "/api/desktop/webapp/grants", "POST", { version: 2, appId: invocation.webappId, execution: granted });
    if (typeof grant?.token !== "string" || !grant.token.startsWith("wap_") || typeof grant.grantId !== "string" || grant.appId !== invocation.webappId || !Number.isSafeInteger(grant.expiresAt) || grant.expiresAt <= Date.now()) throw new ConnectorError("invalid_platform_response");
    try {
      await context.check();
      const method = action.slice("connector.".length);
      const result = await request(identity.baseUrl, grant.token, `/api/webapp/connector/${method}`, "POST", args, false, context.signal);
      await context.check();
      const fresh = await platform(options);
      if (fresh.subject !== identity.subject || JSON.stringify(declared(options, invocation.webappId)) !== JSON.stringify(execution)) throw new ConnectorError("app_grant_required");
      return { ok: true, action, result };
    } finally {
      await request(identity.baseUrl, identity.token, `/api/desktop/webapp/grants?grantId=${encodeURIComponent(grant.grantId)}`, "DELETE").catch(() => {});
    }
  } catch (error) { return { ok: false, action, error: { code: error instanceof ConnectorError ? error.code : "connector_unavailable", message: error instanceof ConnectorError ? error.code : "Connector is unavailable." } }; }
}

async function executeWebappRead(options: DesktopActionBridgeOptions, action: string, args: Record<string, unknown>, context: Awaited<ReturnType<typeof captureWebappContext>>) {
  const { appId, signal } = context;
  const identity = context;
  const item = options.webs.webappManager.list(options.app).find(value => value.id === appId);
  if (!item) throw new ConnectorError("app_grant_required");
  if (action.startsWith("skill.")) {
    const allowed = action === "skill.list" ? [] : ["skillId"];
    if (Object.keys(args).some(key => !allowed.includes(key))) throw new ConnectorError("invalid_arguments");
    const agentKey = item.copilot?.agentKey;
    if (!agentKey) throw new ConnectorError("assistant_agent_unavailable");
    const raw = await request(identity.baseUrl, identity.token, `/api/skills?agentKey=${encodeURIComponent(agentKey)}`, "GET");
    const items = (Array.isArray(raw) ? raw : raw?.skills);
    if (!Array.isArray(items)) throw new ConnectorError("invalid_platform_response");
    const skills = items.filter(value => (item.copilot?.mustUseSkills ?? []).includes(value.key)).map(value => ({ skillId: value.key, name: value.name, description: value.description, agentHasSkill: value.agentHasSkill === true }));
    if ((await platform(options)).subject !== identity.subject) throw new ConnectorError("app_grant_required");
    const result = action === "skill.list" ? { items: skills } : skills.find(value => value.skillId === args.skillId);
    if (!result) throw new ConnectorError("skill_not_found");
    return { ok: true, action, result };
  }
  const allowed = action === "artifact.list" ? ["chatId", "runId", "cursor", "limit"] : ["chatId", "runId", "artifactId"];
  if (Object.keys(args).some(key => !allowed.includes(key))) throw new ConnectorError("invalid_arguments");
  if (typeof args.chatId !== "string" || !applicationChats.get(context.key)?.has(args.chatId)) throw new ConnectorError("app_grant_required");
  const grant = await request(identity.baseUrl, identity.token, "/api/desktop/webapp/grants", "POST", { version: 2, appId, execution: [], chatIds: [args.chatId] });
  if (typeof grant?.token !== "string" || !grant.token.startsWith("wap_") || typeof grant.grantId !== "string" || grant.appId !== appId || !Number.isSafeInteger(grant.expiresAt) || grant.expiresAt <= Date.now()) throw new ConnectorError("invalid_platform_response");
  try {
    await context.check();
    if (action === "artifact.open" || action === "artifact.saveAs") {
      const metadata = await request(identity.baseUrl, grant.token, "/api/webapp/artifact/get", "POST", args, false, signal);
      await context.check();
      if (metadata?.chatId !== args.chatId || metadata?.artifactId !== args.artifactId || typeof metadata.name !== "string") throw new ConnectorError("invalid_platform_response");
      if (action === "artifact.saveAs") {
        const owner = options.getMainWindow();
        if (!owner || owner.isDestroyed()) throw new ConnectorError("desktop_unavailable");
        // Use the native picker on both macOS and Windows; never accept a caller path.
        const selected = await dialog.showSaveDialog(owner, { defaultPath: path.basename(metadata.name.replaceAll("\\", "/")) });
        await context.check();
        if (selected.canceled || !selected.filePath) return { ok: true, action, result: { cancelled: true } };
        const content = await request(identity.baseUrl, grant.token, "/api/webapp/artifact/read", "POST", args, true, signal);
        await context.check();
        await fs.writeFile(selected.filePath, Buffer.from(content.dataBase64, "base64"));
        return { ok: true, action, result: { saved: true } };
      }
      const info = await options.assistantBridge.getChatInfo(args.chatId as string);
      if (!info || info.chatId !== args.chatId || !info.agentKey) throw new ConnectorError("artifact_not_found");
      const raw = JSON.parse(info.rawJson);
      if (raw.chatId !== args.chatId) throw new ConnectorError("artifact_not_found");
      const matches = Array.isArray(raw?.artifact?.items) ? raw.artifact.items.filter((value: any) => value.artifactId === args.artifactId && (!args.runId || value.runId === args.runId)) : [];
      if (matches.length !== 1) throw new ConnectorError("artifact_ambiguous");
      const relativePath = artifactRelativePath(matches[0].url, info.chatId);
      if (!relativePath) throw new ConnectorError("artifact_not_found");
      await context.check();
      const route = `/resource-viewer/${encodeURIComponent(info.agentKey)}?${new URLSearchParams({ chatId: info.chatId, file: relativePath.split("/").map(encodeURIComponent).join("/") })}`;
      const opened = await options.callRendererAction({ requestId: artifactRequestId(), action: "desktop.workpanel.openTab", source: { chatId: info.chatId }, args: {
        descriptor: { kind: "webclient", module: "artifact", route, title: metadata.name,
          context: { agentKey: info.agentKey, chatId: info.chatId, artifactId: args.artifactId, relativePath } }
      } });
      if (!opened.ok) throw new ConnectorError("artifact_preview_unavailable");
      return { ok: true, action, result: { opened: true } };
    }
    const result = await request(identity.baseUrl, grant.token, `/api/webapp/artifact/${action.slice("artifact.".length)}`, "POST", args, action === "artifact.read", signal);
    if ((await platform(options)).subject !== identity.subject || !options.webs.webappManager.list(options.app).some(value => value.id === appId)) throw new ConnectorError("app_grant_required");
    return { ok: true, action, result };
  } finally {
    await request(identity.baseUrl, identity.token, `/api/desktop/webapp/grants?grantId=${encodeURIComponent(grant.grantId)}`, "DELETE").catch(() => {});
  }
}
