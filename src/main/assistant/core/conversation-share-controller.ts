import type { App } from "electron";
import type { AssistantConversationShareResult } from "../../../shared/contracts";
import { readDesktopSsoAccessToken } from "../../oidc-sso";
import { deriveTunnelHubRegistrationApiOrigin } from "../../tunnel-hub-registration";
import { readTunnelHubSettings } from "../../tunnel-hub-settings";
import {
  buildConversationShareSnapshot,
  validateConversationShareSnapshot,
  type AgentPlatformChatTranscriptExportResult,
  type ConversationShareSnapshotValidationError
} from "./conversation-share-types";
import { t } from "../../i18n/main-i18n";

type ConversationShareBridge = {
  downloadChatTranscriptExport(chatId: string): Promise<AgentPlatformChatTranscriptExportResult>;
};

type ConversationShareCreateResponse = {
  id?: unknown;
  url?: unknown;
  createdAt?: unknown;
  error?: unknown;
};

export async function createConversationShare(
  app: App,
  assistantBridge: ConversationShareBridge,
  chatId: string,
  fetchImpl: typeof fetch = fetch
): Promise<AssistantConversationShareResult> {
  const transcriptResult = await assistantBridge.downloadChatTranscriptExport(chatId);
  if (!transcriptResult.ok) {
    return { ok: false, message: transcriptResult.message };
  }
  const snapshot = buildConversationShareSnapshot(transcriptResult.transcript);
  const snapshotError = validateConversationShareSnapshot(snapshot);
  if (snapshotError) {
    return { ok: false, message: shareSnapshotValidationMessage(snapshotError) };
  }
  const connection = resolveConversationShareConnection(app);
  if (!connection.ok) {
    return connection;
  }
  let response: Response;
  try {
    response = await fetchImpl(`${connection.origin}/api/desktop/shares`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${connection.token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(snapshot),
      signal: AbortSignal.timeout(15_000)
    });
  } catch (error) {
    return { ok: false, message: t("assistant.chatShareTunnelUnavailable", { message: messageFromError(error) }) };
  }
  const payload = await readConversationShareResponse(response);
  if (!response.ok) {
    return { ok: false, message: shareServiceError(response.status, payload) };
  }
  const shareId = readText(payload.id);
  const url = readText(payload.url);
  if (!shareId || !url || !isSafePublicShareURL(url)) {
    return { ok: false, message: t("assistant.chatShareInvalidUrl") };
  }
  return {
    ok: true,
    message: t("assistant.chatShareCreated"),
    shareId,
    url,
    createdAt: readText(payload.createdAt)
  };
}

function shareSnapshotValidationMessage(error: ConversationShareSnapshotValidationError) {
  switch (error) {
    case "empty":
      return t("assistant.chatShareEmptyTranscript");
    case "entry-limit":
    case "title-size":
    case "entry-size":
    case "label-size":
    case "payload-size":
      return t("assistant.chatShareSnapshotTooLarge");
    case "invalid-time":
      return t("assistant.chatShareInvalidTranscript");
  }
}

export async function revokeConversationShare(
  app: App,
  shareId: string,
  fetchImpl: typeof fetch = fetch
): Promise<AssistantConversationShareResult> {
  const normalizedShareId = shareId.trim();
  if (!/^share_[A-Za-z0-9_-]+$/u.test(normalizedShareId)) {
    return { ok: false, message: t("assistant.chatShareInvalidId") };
  }
  const connection = resolveConversationShareConnection(app);
  if (!connection.ok) {
    return connection;
  }
  let response: Response;
  try {
    response = await fetchImpl(
      `${connection.origin}/api/desktop/shares/${encodeURIComponent(normalizedShareId)}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${connection.token}` },
        signal: AbortSignal.timeout(10_000)
      }
    );
  } catch (error) {
    return { ok: false, message: t("assistant.chatShareTunnelUnavailable", { message: messageFromError(error) }) };
  }
  if (!response.ok) {
    const payload = await readConversationShareResponse(response);
    return { ok: false, message: shareServiceError(response.status, payload) };
  }
  return { ok: true, message: t("assistant.chatShareRevoked"), shareId: normalizedShareId };
}

function resolveConversationShareConnection(app: App):
  | { ok: true; origin: string; token: string }
  | { ok: false; message: string } {
  const token = readDesktopSsoAccessToken(app);
  if (!token) {
    return { ok: false, message: t("assistant.chatShareLoginRequired") };
  }
  const settings = readTunnelHubSettings(app);
  if (!settings.enabled || !settings.relayUrl) {
    return { ok: false, message: t("assistant.chatShareTunnelRequired") };
  }
  try {
    return {
      ok: true,
      origin: deriveTunnelHubRegistrationApiOrigin(settings.relayUrl),
      token
    };
  } catch (error) {
    return { ok: false, message: t("assistant.chatShareTunnelUrlInvalid", { message: messageFromError(error) }) };
  }
}

async function readConversationShareResponse(response: Response): Promise<ConversationShareCreateResponse> {
  try {
    const value: unknown = await response.json();
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as ConversationShareCreateResponse
      : {};
  } catch {
    return {};
  }
}

function shareServiceError(status: number, payload: ConversationShareCreateResponse) {
  if (status === 401 || status === 403) {
    return t("assistant.chatShareUnauthorized");
  }
  if (status === 404 || status === 405) {
    return t("assistant.chatShareTunnelUnsupported");
  }
  return readText(payload.error) || t("assistant.chatShareTunnelFailed", { status });
}

function isSafePublicShareURL(value: string) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || (parsed.protocol === "http:" && ["127.0.0.1", "localhost"].includes(parsed.hostname));
  } catch {
    return false;
  }
}

function readText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function messageFromError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
