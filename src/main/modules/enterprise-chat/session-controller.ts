import type {
  EnterpriseChatSnapshot,
  EnterpriseChatUser
} from "../../../shared/contracts";
import {
  EnterpriseChatActionLedger
} from "./action-ledger";
import { ENTERPRISE_CHAT_REQUEST_TIMEOUT_MS, EnterpriseChatRequestError, FetchLike, ServerSession, WebSocketLike, normalizeServerUrl } from "./connection-transport";
import {
  readEnterpriseChatSelfProfile
} from "./local-profile";
import { ServerBootstrap, mergeConversationUsers, normalizeConversations, normalizeUser } from "./message-projection";
import { errorMessage, isRecord, readNumber, readText } from "./protocol-values";

export interface SessionControllerDependencies {
  serverUrl: string;
  disconnect(): void;
  clearSession(): void;
  updateSnapshot(patch: Partial<EnterpriseChatSnapshot>): void;
  getState(): EnterpriseChatSnapshot;
  readonly snapshot: EnterpriseChatSnapshot;
  readonly getIdentityToken: () => string | null;
  readonly socket: WebSocketLike | null;
  refresh(): Promise<EnterpriseChatSnapshot>;
  refreshPromise: Promise<EnterpriseChatSnapshot> | null;
  performRefresh(): Promise<EnterpriseChatSnapshot>;
  readonly getServerUrl: () => string;
  setEnabled(enabled: boolean): Promise<EnterpriseChatSnapshot>;
  updateServerUrl(): void;
  exchangeSession(identityToken: string): Promise<ServerSession>;
  readonly refreshIdentityToken?: (() => Promise<string | null>) | undefined;
  imSessionToken: string;
  imSessionTokenExpiresAt: number;
  scheduleSessionRefresh(): void;
  requestBootstrap(): Promise<ServerBootstrap>;
  requestUsers(): Promise<EnterpriseChatUser[]>;
  readonly app: Electron.App;
  readonly platform: NodeJS.Platform;
  currentDesktopActionScope(): string;
  readonly recoveredDesktopActionScopes: Set<string>;
  getDesktopActionLedger(): EnterpriseChatActionLedger | null;
  connectWebSocket(): Promise<void>;
  readonly getDeviceInfo: () => { deviceId: string; deviceName: string; };
  requestJson<T>(path: string, init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
  }, useImSessionToken?: boolean): Promise<T>;
  readonly fetchImpl: FetchLike;
  sessionRefreshTimer: NodeJS.Timeout | null;
}

export async function setEnabled(dependencies: SessionControllerDependencies, enabled: boolean) {
  if (!enabled || !dependencies.serverUrl) {
    dependencies.disconnect();
    dependencies.clearSession();
    dependencies.updateSnapshot({
      enabled: false,
      connectionState: "disabled",
      message: "",
      currentUser: null,
      selfProfile: { motto: "", avatarDataUrl: "", hasCustomAvatar: false },
      users: [],
      conversations: [],
      activeConversationId: "",
      activeMessages: [],
      latestEventId: 0
    });
    return dependencies.getState();
  }
  const wasEnabled = dependencies.snapshot.enabled;
  dependencies.updateSnapshot({
    enabled: true,
    connectionState: dependencies.getIdentityToken() ? "connecting" : "signed_out",
    message: ""
  });
  if (!wasEnabled || !dependencies.socket) {
    return dependencies.refresh();
  }
  return dependencies.getState();
}

export async function refresh(dependencies: SessionControllerDependencies) {
  if (dependencies.refreshPromise) {
    return dependencies.refreshPromise;
  }
  dependencies.refreshPromise = dependencies.performRefresh().finally(() => {
    dependencies.refreshPromise = null;
  });
  return dependencies.refreshPromise;
}

export async function reloadConfiguration(dependencies: SessionControllerDependencies, enabled: boolean) {
  const nextServerUrl = normalizeServerUrl(dependencies.getServerUrl());
  if (nextServerUrl !== dependencies.serverUrl) {
    dependencies.disconnect();
    dependencies.clearSession();
    dependencies.serverUrl = nextServerUrl;
    dependencies.updateSnapshot({ serverUrl: nextServerUrl });
  }
  return dependencies.setEnabled(enabled);
}

export async function performRefresh(dependencies: SessionControllerDependencies) {
  if (!dependencies.snapshot.enabled) {
    return dependencies.getState();
  }
  const identityToken = readText(dependencies.getIdentityToken());
  if (!identityToken) {
    dependencies.disconnect();
    dependencies.clearSession();
    dependencies.updateSnapshot({
      connectionState: "signed_out",
      message: "",
      currentUser: null,
      selfProfile: { motto: "", avatarDataUrl: "", hasCustomAvatar: false },
      users: [],
      conversations: [],
      activeConversationId: "",
      activeMessages: [],
      latestEventId: 0
    });
    return dependencies.getState();
  }
  dependencies.disconnect();
  dependencies.clearSession();
  try {
    dependencies.updateServerUrl();
    dependencies.updateSnapshot({
      connectionState: "connecting",
      message: "",
      serverUrl: dependencies.serverUrl
    });
    let session: ServerSession;
    try {
      session = await dependencies.exchangeSession(identityToken);
    }
    catch (error) {
      if (!(error instanceof EnterpriseChatRequestError) || error.status !== 401 || !dependencies.refreshIdentityToken) {
        throw error;
      }
      const refreshedIdentityToken = readText(await dependencies.refreshIdentityToken());
      if (!refreshedIdentityToken) {
        throw error;
      }
      session = await dependencies.exchangeSession(refreshedIdentityToken);
    }
    dependencies.imSessionToken = session.token;
    dependencies.imSessionTokenExpiresAt = session.expiresAt;
    dependencies.scheduleSessionRefresh();
    const [bootstrap, users] = await Promise.all([
      dependencies.requestBootstrap(),
      dependencies.requestUsers()
    ]);
    const bootstrapCurrentUser = bootstrap.user.id ? bootstrap.user : session.user;
    const directoryCurrentUser = users.find((user) => user.id === bootstrapCurrentUser.id);
    const currentUser = directoryCurrentUser
      ? { ...bootstrapCurrentUser, ...directoryCurrentUser }
      : bootstrapCurrentUser;
    const visibleUsers = users.filter((user) => user.id && user.id !== currentUser.id);
    const selfProfile = readEnterpriseChatSelfProfile(dependencies.app, dependencies.platform, dependencies.serverUrl, currentUser.id);
    dependencies.updateSnapshot({
      currentUser,
      selfProfile,
      users: visibleUsers,
      conversations: mergeConversationUsers(bootstrap.conversations, [currentUser, ...visibleUsers]),
      latestEventId: bootstrap.latestEventId,
      activeConversationId: "",
      activeMessages: [],
      connectionState: "connecting",
      message: ""
    });
    const actionScope = dependencies.currentDesktopActionScope();
    if (actionScope && !dependencies.recoveredDesktopActionScopes.has(actionScope)) {
      dependencies.recoveredDesktopActionScopes.add(actionScope);
      if (dependencies.getDesktopActionLedger()?.recoverExecuting(actionScope).length) {
        dependencies.updateSnapshot({});
      }
    }
    await dependencies.connectWebSocket();
  }
  catch (error) {
    dependencies.disconnect();
    dependencies.clearSession();
    dependencies.updateSnapshot({
      connectionState: "error",
      message: errorMessage(error),
      currentUser: null,
      selfProfile: { motto: "", avatarDataUrl: "", hasCustomAvatar: false },
      users: [],
      conversations: [],
      activeConversationId: "",
      activeMessages: [],
      latestEventId: 0
    });
  }
  return dependencies.getState();
}

export function updateServerUrl(dependencies: SessionControllerDependencies) {
  dependencies.serverUrl = normalizeServerUrl(dependencies.getServerUrl());
}

export function handleSignedOut(dependencies: SessionControllerDependencies) {
  dependencies.disconnect();
  dependencies.clearSession();
  dependencies.updateSnapshot({
    connectionState: dependencies.snapshot.enabled ? "signed_out" : "disabled",
    message: "",
    currentUser: null,
    selfProfile: { motto: "", avatarDataUrl: "", hasCustomAvatar: false },
    users: [],
    conversations: [],
    activeConversationId: "",
    activeMessages: [],
    latestEventId: 0
  });
}

export function stop(dependencies: SessionControllerDependencies) {
  dependencies.disconnect();
  dependencies.clearSession();
}

export async function ensureSession(dependencies: SessionControllerDependencies) {
  if (dependencies.imSessionToken &&
    dependencies.imSessionTokenExpiresAt > Date.now() + 30000) {
    return;
  }
  const state = await dependencies.refresh();
  if (!dependencies.imSessionToken || state.connectionState === "error") {
    throw new Error(state.message || "Enterprise chat session is unavailable.");
  }
}

export async function exchangeSession(dependencies: SessionControllerDependencies, identityToken: string): Promise<ServerSession> {
  const device = dependencies.getDeviceInfo();
  const response = await dependencies.requestJson<unknown>("/api/v1/session/exchange", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${identityToken}`
    },
    body: JSON.stringify({
      deviceId: device.deviceId,
      deviceName: device.deviceName
    })
  }, false);
  const record = isRecord(response) ? response : {};
  const token = readText(record.token);
  const expiresAt = readNumber(record.expiresAt);
  const user = normalizeUser(record.user);
  if (!token || expiresAt <= Date.now() || !user.id) {
    throw new Error("The IM server returned an invalid session.");
  }
  return { token, expiresAt, user };
}

export async function requestBootstrap(dependencies: SessionControllerDependencies): Promise<ServerBootstrap> {
  const response = await dependencies.requestJson<unknown>("/api/v1/sync/bootstrap");
  const record = isRecord(response) ? response : {};
  const user = normalizeUser(record.user);
  if (!user.id) {
    throw new Error("The IM server returned an invalid employee identity.");
  }
  return {
    user,
    conversations: normalizeConversations(record.conversations),
    latestEventId: Math.max(0, Math.trunc(readNumber(record.latestEventId)))
  };
}

export async function requestUsers(dependencies: SessionControllerDependencies) {
  const users: EnterpriseChatUser[] = [];
  const pageSize = 100;
  for (let offset = 0;offset < 10000;offset += pageSize) {
    const response = await dependencies.requestJson<unknown>(`/api/v1/users?limit=${pageSize}&offset=${offset}`);
    const record = isRecord(response) ? response : {};
    const page = Array.isArray(record.items)
      ? record.items.map(normalizeUser).filter((user) => user.id)
      : [];
    users.push(...page);
    if (page.length < pageSize) {
      break;
    }
  }
  return users;
}

export async function requestJson<T>(dependencies: SessionControllerDependencies, path: string, init: {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
} = {}, useImSessionToken = true): Promise<T> {
  if (!dependencies.fetchImpl) {
    throw new Error("This Desktop runtime does not provide fetch support.");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ENTERPRISE_CHAT_REQUEST_TIMEOUT_MS);
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...(typeof init.body === "string" ? { "Content-Type": "application/json" } : {}),
    ...init.headers
  };
  if (useImSessionToken) {
    if (!dependencies.imSessionToken) {
      clearTimeout(timeout);
      throw new Error("Enterprise chat session is unavailable.");
    }
    headers.Authorization = `Bearer ${dependencies.imSessionToken}`;
  }
  try {
    const response = await dependencies.fetchImpl(`${dependencies.serverUrl}${path}`, {
      ...init,
      headers,
      signal: controller.signal
    });
    if (!response.ok) {
      let detail = "";
      try {
        const payload = await response.json();
        const record = isRecord(payload) ? payload : {};
        const error = isRecord(record.error) ? record.error : {};
        detail = readText(error.message) || readText(record.message);
      }
      catch {
        detail = readText(await response.text().catch(() => ""));
      }
      throw new EnterpriseChatRequestError(response.status, detail || `Enterprise chat request failed (${response.status}).`);
    }
    return await response.json() as T;
  }
  finally {
    clearTimeout(timeout);
  }
}

export function clearSession(dependencies: SessionControllerDependencies) {
  dependencies.imSessionToken = "";
  dependencies.imSessionTokenExpiresAt = 0;
  if (dependencies.sessionRefreshTimer) {
    clearTimeout(dependencies.sessionRefreshTimer);
    dependencies.sessionRefreshTimer = null;
  }
}

export function scheduleSessionRefresh(dependencies: SessionControllerDependencies) {
  if (dependencies.sessionRefreshTimer) {
    clearTimeout(dependencies.sessionRefreshTimer);
  }
  const delay = Math.max(5000, dependencies.imSessionTokenExpiresAt - Date.now() - 60000);
  dependencies.sessionRefreshTimer = setTimeout(() => {
    dependencies.sessionRefreshTimer = null;
    void dependencies.refresh();
  }, delay);
}
