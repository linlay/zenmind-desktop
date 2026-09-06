import type { App } from "electron";
import {
  isAssistantConversationShareExpiration,
  type AssistantConversationShareCreateResult,
  type AssistantConversationShareListResult,
  type AssistantConversationShareRequest,
  type AssistantConversationShareRevokeResult,
} from "../../../shared/contracts";
import { t } from "../../support/i18n/main-i18n";
import type { ConversationHtmlRenderer } from "./export-contract";
import { resolveConversationShareTarget } from "./target";
import {
  TunnelConversationShareError,
  type ConversationShareCreator,
  type ConversationShareReader,
  type ConversationShareRevoker,
} from "./tunnel-client";

export async function createConversationShare(
  app: App,
  documentRenderer: ConversationHtmlRenderer,
  shareCreator: ConversationShareCreator,
  request: AssistantConversationShareRequest,
): Promise<AssistantConversationShareCreateResult> {
  const conversationId = typeof request?.chatId === "string" ? request.chatId.trim() : "";
  if (!conversationId) {
    return { ok: false, message: t("assistant.chatIdRequired") };
  }
  if (!isValidConversationId(conversationId)) {
    return { ok: false, message: t("assistant.chatShareConversationIdInvalid") };
  }
  if (!isAssistantConversationShareExpiration(request.expiration)) {
    return { ok: false, message: t("assistant.chatShareExpirationInvalid") };
  }
  const target = resolveConversationShareTarget(app);
  if (!target.ok) {
    return target;
  }

  let rendered: Awaited<ReturnType<ConversationHtmlRenderer["renderChatHtml"]>>;
  try {
    rendered = await documentRenderer.renderChatHtml(
      conversationId,
      target.target.origin,
    );
  } catch {
    return { ok: false, message: t("assistant.chatShareRequestFailed") };
  }
  if (!rendered.ok) {
    return { ok: false, message: rendered.message };
  }

  try {
    const record = await shareCreator.create({
      target: target.target,
      conversationId,
      expiration: request.expiration,
      html: rendered.bytes,
    });
    return {
      ok: true,
      message: t("assistant.chatShareCreated"),
      record,
    };
  } catch (error) {
    return { ok: false, message: mapTunnelShareError(error, "create") };
  }
}

export async function listConversationShares(
  app: App,
  shareReader: ConversationShareReader,
  chatId: string,
): Promise<AssistantConversationShareListResult> {
  const conversationId = typeof chatId === "string" ? chatId.trim() : "";
  if (!conversationId) {
    return { ok: false, message: t("assistant.chatIdRequired") };
  }
  if (!isValidConversationId(conversationId)) {
    return { ok: false, message: t("assistant.chatShareConversationIdInvalid") };
  }
  const target = resolveConversationShareTarget(app);
  if (!target.ok) {
    return target;
  }
  try {
    const records = await shareReader.list(target.target, conversationId);
    return { ok: true, message: "", records };
  } catch (error) {
    return { ok: false, message: mapTunnelShareError(error, "list") };
  }
}

export async function revokeConversationShare(
  app: App,
  shareRevoker: ConversationShareRevoker,
  shareId: string,
): Promise<AssistantConversationShareRevokeResult> {
  const normalizedShareId = typeof shareId === "string" ? shareId.trim() : "";
  if (!/^[A-Za-z0-9_-]{1,80}$/u.test(normalizedShareId)) {
    return { ok: false, message: t("assistant.chatShareInvalidId") };
  }
  const target = resolveConversationShareTarget(app);
  if (!target.ok) {
    return target;
  }
  try {
    await shareRevoker.revoke(target.target, normalizedShareId);
    return {
      ok: true,
      message: t("assistant.chatShareRevoked"),
      shareId: normalizedShareId,
    };
  } catch (error) {
    return { ok: false, message: mapTunnelShareError(error, "revoke") };
  }
}

function mapTunnelShareError(
  error: unknown,
  action: "create" | "list" | "revoke",
): string {
  if (!(error instanceof TunnelConversationShareError)) {
    return t("assistant.chatShareRequestFailed");
  }
  if (error.status === 401 || error.status === 403) {
    return t("assistant.chatShareUnauthorized");
  }
  if (error.status === 413) {
    return t("assistant.chatShareSnapshotTooLarge");
  }
  if (error.status === 404 && action === "revoke") {
    return t("assistant.chatShareMissing");
  }
  if (
    error.kind === "timeout" ||
    error.kind === "unavailable" ||
    (error.status !== undefined && error.status >= 500)
  ) {
    return t("assistant.chatShareTunnelUnavailable");
  }
  if (error.kind === "invalid_response") {
    return t("assistant.chatShareInvalidResponse");
  }
  return t("assistant.chatShareRequestFailed");
}

function isValidConversationId(value: string): boolean {
  return Buffer.byteLength(value, "utf8") <= 255 && !/\p{Cc}/u.test(value);
}
