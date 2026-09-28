import { parseSafeLoopbackWebUrl } from "../../infrastructure/network/loopback-url";
import { t } from "../../support/i18n/main-i18n";
import {
  AgentPlatformChatExportResult,
  AgentPlatformRawChatJSONLResult,
  MAX_CONVERSATION_MARKDOWN_BYTES,
  MAX_RAW_CHAT_JSONL_BYTES
} from "./bridge-contracts";
import type { PlatformClient } from "./platform-client";
import {
  filenameFromContentDisposition,
  readErrorText,
  readResponseBytesWithLimit,
  ResponseBytesTooLargeError
} from "./platform-http-response";

/** Private chat export operations behind the Assistant facade. */
export class ChatExportClient {
  constructor(
    private readonly platform: Pick<PlatformClient, "resolvePlatform" | "platformFetch">
  ) {}

  async downloadChatExport(chatId: string): Promise<AgentPlatformChatExportResult> {
    const trimmedChatId = chatId.trim();
    if (!trimmedChatId) {
      return {
        ok: false,
        message: t("assistant.chatIdRequired"),
        filename: ""
      };
    }
    const availability = await this.platform.resolvePlatform();
    if (!availability.ok) {
      return { ok: false, message: availability.message, filename: "" };
    }
    const response = await this.platform.platformFetch(availability.baseUrl, `/api/chat/export?chatId=${encodeURIComponent(trimmedChatId)}&format=markdown`, {
      method: "GET",
      headers: {
        Accept: "text/markdown, application/json",
        Authorization: `Bearer ${availability.token}`
      }
    });
    if (!response.ok) {
      return {
        ok: false,
        message: await readErrorText(response),
        filename: ""
      };
    }
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
    if (contentType !== "text/markdown") {
      return {
        ok: false,
        message: t("assistant.chatExportUnsupported"),
        filename: ""
      };
    }
    try {
      return {
        ok: true,
        message: t("assistant.chatExportDownloaded"),
        filename: filenameFromContentDisposition(response.headers.get("content-disposition")) || `${trimmedChatId}.md`,
        bytes: await readResponseBytesWithLimit(response, MAX_CONVERSATION_MARKDOWN_BYTES)
      };
    }
    catch (error) {
      return {
        ok: false,
        message: error instanceof ResponseBytesTooLargeError
          ? t("assistant.chatExportTooLarge")
          : t("assistant.chatExportReadFailed"),
        filename: ""
      };
    }
  }

  async createChatSnapshotRequest(chatId: string): Promise<
    | { ok: true; snapshotUrl: string; bearerToken: string }
    | { ok: false; message: string }
  > {
    const trimmedChatId = chatId.trim();
    if (!trimmedChatId) {
      return { ok: false, message: t("assistant.chatIdRequired") };
    }
    const availability = await this.platform.resolvePlatform();
    if (!availability.ok) {
      return availability;
    }
    const baseURL = parseSafeLoopbackWebUrl(availability.baseUrl);
    if (!baseURL) {
      return { ok: false, message: t("assistant.chatHtmlExportUnsupported") };
    }
    const snapshotURL = new URL("/api/chat/export", baseURL.origin);
    snapshotURL.searchParams.set("chatId", trimmedChatId);
    snapshotURL.searchParams.set("format", "snapshot");
    return {
      ok: true,
      snapshotUrl: snapshotURL.toString(),
      bearerToken: availability.token
    };
  }

  async downloadRawChatJSONL(chatId: string): Promise<AgentPlatformRawChatJSONLResult> {
    const trimmedChatId = chatId.trim();
    if (!trimmedChatId) {
      return { ok: false, message: t("assistant.chatIdRequired") };
    }
    const availability = await this.platform.resolvePlatform();
    if (!availability.ok) {
      return { ok: false, message: availability.message };
    }
    const response = await this.platform.platformFetch(availability.baseUrl, `/api/chat/jsonl?chatId=${encodeURIComponent(trimmedChatId)}`, {
      method: "GET",
      headers: {
        Accept: "text/plain, application/x-ndjson",
        Authorization: `Bearer ${availability.token}`
      }
    });
    if (!response.ok) {
      return { ok: false, message: await readErrorText(response) };
    }
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
    if (contentType !== "text/plain" && contentType !== "application/x-ndjson") {
      return { ok: false, message: t("assistant.rawChatJsonlUnsupported") };
    }
    try {
      return {
        ok: true,
        filename: filenameFromContentDisposition(response.headers.get("content-disposition")) || `${trimmedChatId}.jsonl`,
        bytes: await readResponseBytesWithLimit(response, MAX_RAW_CHAT_JSONL_BYTES)
      };
    }
    catch (error) {
      return {
        ok: false,
        message: error instanceof ResponseBytesTooLargeError
          ? t("assistant.rawChatJsonlTooLarge")
          : t("assistant.rawChatJsonlReadFailed")
      };
    }
  }
}
