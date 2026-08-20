import fs from "node:fs";
import path from "node:path";
import type { App } from "electron";
import {
  isAssistantConversationShareExpiration,
  type AssistantConversationShareCreateResult,
  type AssistantConversationShareListResult,
  type AssistantConversationShareRequest,
  type AssistantConversationShareRevokeResult,
} from "../../../shared/contracts";
import { readDesktopSsoSiteAccessToken } from "../../sso-site-token";
import { deriveTunnelHubRegistrationApiOrigin } from "../../tunnel-hub-registration";
import { readTunnelHubSettings } from "../../tunnel-hub-settings";
import { t } from "../../i18n/main-i18n";
import { isDesktopDevelopmentRuntime } from "../../development-runtime";

const LOCAL_SHARE_RELAY_ENV = "DESKTOP_CONVERSATION_SHARE_RELAY_URL";
const LOCAL_SHARE_TOKEN_FILE_ENV = "DESKTOP_CONVERSATION_SHARE_TOKEN_FILE";

type ConversationShareBridge = {
  createChatShare(input: {
    chatId: string;
    expiration: AssistantConversationShareRequest["expiration"];
    tunnelOrigin: string;
    tunnelAuthorization: string;
  }): Promise<AssistantConversationShareCreateResult>;
  listChatShares(input: {
    chatId: string;
    tunnelOrigin: string;
    tunnelAuthorization: string;
  }): Promise<AssistantConversationShareListResult>;
  revokeChatShare(input: {
    shareId: string;
    tunnelOrigin: string;
    tunnelAuthorization: string;
  }): Promise<AssistantConversationShareRevokeResult>;
};

export async function createConversationShare(
  app: App,
  assistantBridge: ConversationShareBridge,
  request: AssistantConversationShareRequest,
): Promise<AssistantConversationShareCreateResult> {
  const normalizedChatId = typeof request?.chatId === "string" ? request.chatId.trim() : "";
  if (!normalizedChatId) {
    return { ok: false, message: t("assistant.chatIdRequired") };
  }
  if (!isAssistantConversationShareExpiration(request.expiration)) {
    return { ok: false, message: t("assistant.chatShareExpirationInvalid") };
  }
  const connection = resolveConversationShareConnection(app);
  if (!connection.ok) {
    return connection;
  }
  try {
    return await assistantBridge.createChatShare({
      chatId: normalizedChatId,
      expiration: request.expiration,
      tunnelOrigin: connection.origin,
      tunnelAuthorization: `Bearer ${connection.token}`
    });
  } catch {
    return { ok: false, message: t("assistant.chatShareRequestFailed") };
  }
}

export async function listConversationShares(
  app: App,
  assistantBridge: ConversationShareBridge,
  chatId: string,
): Promise<AssistantConversationShareListResult> {
  const normalizedChatId = typeof chatId === "string" ? chatId.trim() : "";
  if (!normalizedChatId) {
    return { ok: false, message: t("assistant.chatIdRequired") };
  }
  const connection = resolveConversationShareConnection(app);
  if (!connection.ok) {
    return connection;
  }
  try {
    return await assistantBridge.listChatShares({
      chatId: normalizedChatId,
      tunnelOrigin: connection.origin,
      tunnelAuthorization: `Bearer ${connection.token}`
    });
  } catch {
    return { ok: false, message: t("assistant.chatShareRequestFailed") };
  }
}

export async function revokeConversationShare(
  app: App,
  assistantBridge: ConversationShareBridge,
  shareId: string,
): Promise<AssistantConversationShareRevokeResult> {
  const normalizedShareId = shareId.trim();
  if (!isValidConversationShareId(normalizedShareId)) {
    return { ok: false, message: t("assistant.chatShareInvalidId") };
  }
  const connection = resolveConversationShareConnection(app);
  if (!connection.ok) {
    return connection;
  }
  try {
    return await assistantBridge.revokeChatShare({
      shareId: normalizedShareId,
      tunnelOrigin: connection.origin,
      tunnelAuthorization: `Bearer ${connection.token}`
    });
  } catch {
    return { ok: false, message: t("assistant.chatShareRequestFailed") };
  }
}

function isValidConversationShareId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,80}$/u.test(value);
}

function resolveConversationShareConnection(app: App):
  | { ok: true; origin: string; token: string }
  | { ok: false; message: string } {
  const developmentRuntime = isDesktopDevelopmentRuntime(app);
  const developmentTokenFile = developmentRuntime
    ? process.env[LOCAL_SHARE_TOKEN_FILE_ENV]?.trim() || ""
    : "";
  const developmentToken = developmentTokenFile
    ? readDevelopmentConversationShareToken(developmentTokenFile)
    : "";
  if (developmentTokenFile && !developmentToken) {
    return { ok: false, message: t("assistant.chatShareLocalTokenInvalid") };
  }
  const token = developmentToken || readDesktopSsoSiteAccessToken(app);
  if (!token) {
    return { ok: false, message: t("assistant.chatShareLoginRequired") };
  }
  const developmentRelayUrl = developmentRuntime
    ? process.env[LOCAL_SHARE_RELAY_ENV]?.trim() || ""
    : "";
  const assetOrigin = resolveConversationTunnelOrigin(app, true, {
    relayUrlOverride: developmentRelayUrl,
    allowLoopbackHTTP: developmentRuntime,
  });
  if (!assetOrigin.ok) return assetOrigin;
  return { ok: true, origin: assetOrigin.origin, token };
}

export function resolveConversationAssetOrigin(app: App):
  | { ok: true; origin: string }
  | { ok: false; message: string } {
  return resolveConversationTunnelOrigin(app, false);
}

function resolveConversationTunnelOrigin(
  app: App,
  requireEnabled: boolean,
  options: {
    relayUrlOverride?: string;
    allowLoopbackHTTP?: boolean;
  } = {},
):
  | { ok: true; origin: string }
  | { ok: false; message: string } {
  const settings = readTunnelHubSettings(app);
  const relayUrlOverride = options.relayUrlOverride?.trim() || "";
  const relayUrl = relayUrlOverride || settings.relayUrl;
  if (!relayUrl || (requireEnabled && !relayUrlOverride && !settings.enabled)) {
    return { ok: false, message: t("assistant.chatShareTunnelRequired") };
  }
  try {
    const origin = deriveTunnelHubRegistrationApiOrigin(relayUrl);
    if (!isHttpsOrigin(origin) && !(options.allowLoopbackHTTP && isLoopbackHttpOrigin(origin))) {
      throw new Error("Tunnel share API must use HTTPS.");
    }
    return { ok: true, origin };
  } catch (error) {
    return { ok: false, message: t("assistant.chatShareTunnelUrlInvalid", { message: messageFromError(error) }) };
  }
}

function readDevelopmentConversationShareToken(tokenFile: string): string {
  if (!path.isAbsolute(tokenFile)) {
    return "";
  }
  try {
    const token = fs.readFileSync(tokenFile, "utf8").trim();
    return /^[^\s.]+\.[^\s.]+\.[^\s.]+$/u.test(token) ? token : "";
  } catch {
    return "";
  }
}

function isLoopbackHttpOrigin(value: string): boolean {
  try {
    const parsed = new URL(value);
    const hostname = parsed.hostname.toLowerCase();
    return parsed.protocol === "http:" &&
      value === parsed.origin &&
      (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]");
  } catch {
    return false;
  }
}

function isHttpsOrigin(value: string) {
  const parsed = new URL(value);
  return parsed.protocol === "https:" && value === parsed.origin;
}

function messageFromError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
