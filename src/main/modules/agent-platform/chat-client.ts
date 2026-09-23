import type {
  AssistantChatDetail,
  AssistantChatInfo,
  AssistantChatSearchRequest,
  AssistantChatSearchResponse,
  AssistantChatSummary,
  AssistantHistoryChatItem,
  AssistantHistoryChatsResult,
  AssistantRunEvent
} from "../../../shared/contracts";
import { t } from "../../support/i18n/main-i18n";
import { PlatformArchiveChatResponse, PlatformChatDetail, PlatformChatSearchResponse, PlatformChatSummary } from "./bridge-contracts";
import { nowEpochMillis, readString } from "./bridge-values";
import { mapChatSearchResponse, mapChatSummary, mapHistoryChat, mapRunMessages } from "./chat-projections";
import type { PlatformClient } from "./platform-client";
import {
  normalizePlatformEvent,
  readOptionalPlatformTimestamp,
  readRequiredPlatformTimestamp,
  validatePresentPlatformTimes
} from "./platform-event-normalizer";
import { readErrorText, unwrapApiResponse } from "./platform-http-response";

/** Private chat client operations behind the Assistant facade. */
export class ChatClient {
  constructor(
    private readonly platform: Pick<PlatformClient, "getJson" | "resolvePlatform" | "platformFetch" | "jsonHeaders">
  ) {}

  async listChats(): Promise<AssistantChatSummary[]> {
    const data = await this.platform.getJson<PlatformChatSummary[]>("/api/chats");
    return Array.isArray(data)
      ? data
        .map((summary, index) => mapChatSummary(summary, `chats[${index}]`))
        .filter((summary): summary is AssistantChatSummary => summary !== null)
      : [];
  }

  async listHistoryChats(): Promise<AssistantHistoryChatsResult> {
    const availability = await this.platform.resolvePlatform();
    if (!availability.ok) {
      return {
        ok: false,
        items: [],
        message: availability.message,
        updatedAt: nowEpochMillis(),
      };
    }
    const response = await this.platform.platformFetch(availability.baseUrl, "/api/chats", {
      headers: this.platform.jsonHeaders(availability.token),
    });
    if (!response.ok) {
      return {
        ok: false,
        items: [],
        message: await readErrorText(response),
        updatedAt: nowEpochMillis(),
      };
    }
    const data = unwrapApiResponse<PlatformChatSummary[]>(await response.json());
    const items = Array.isArray(data)
      ? data
        .map((summary, index) => mapHistoryChat(summary, `historyChats[${index}]`))
        .filter((summary): summary is AssistantHistoryChatItem => summary !== null)
        .sort((left, right) => right.updatedAt - left.updatedAt || left.chatId.localeCompare(right.chatId))
      : [];
    return {
      ok: true,
      items,
      message: "",
      updatedAt: nowEpochMillis(),
    };
  }

  async getChat(chatId: string): Promise<AssistantChatDetail | null> {
    const trimmedChatId = chatId.trim();
    if (!trimmedChatId) {
      return null;
    }
    const data = await this.platform.getJson<PlatformChatDetail>(`/api/chat?chatId=${encodeURIComponent(trimmedChatId)}&includeRawMessages=true`, {
      allowNotFound: true
    });
    if (!data) {
      return null;
    }
    validatePresentPlatformTimes(data as Record<string, unknown>, "chat");
    const events = Array.isArray(data.events)
      ? data.events
        .map((event, index) => normalizePlatformEvent(event, { runId: readString(event.runId), chatId: trimmedChatId }, `chat.events[${index}]`))
        .filter((event): event is AssistantRunEvent => Boolean(event &&
          event.type !== "delta" &&
          event.type !== "done" &&
          event.type !== "error" &&
          event.type !== "stopped"))
      : [];
    const messages = Array.isArray(data.runs)
      ? data.runs.flatMap((run, index) => mapRunMessages(run, `chat.runs[${index}]`))
      : [];
    return {
      summary: {
        id: readString(data.chatId) || trimmedChatId,
        title: readString(data.chatName) || t("assistant.newChat"),
        createdAt: readRequiredPlatformTimestamp(data.createdAt, "chat.createdAt"),
        updatedAt: readRequiredPlatformTimestamp(data.updatedAt, "chat.updatedAt"),
        lastMessage: messages[messages.length - 1]?.content ?? "",
        messageCount: messages.length
      },
      messages,
      events
    };
  }

  async getChatInfo(chatId: string): Promise<AssistantChatInfo | null> {
    const trimmedChatId = typeof chatId === "string" ? chatId.trim() : "";
    if (!trimmedChatId) {
      return null;
    }
    const data = await this.platform.getJson<PlatformChatDetail>(`/api/chat?chatId=${encodeURIComponent(trimmedChatId)}&includeRawMessages=false`, { allowNotFound: true });
    if (!data) {
      return null;
    }
    if (typeof data !== "object" || Array.isArray(data)) {
      throw new Error("Agent Platform returned an invalid chat detail response.");
    }
    validatePresentPlatformTimes(data, "chatInfo");
    const createdAt = readOptionalPlatformTimestamp(data.createdAt, "chatInfo.createdAt");
    const updatedAt = readOptionalPlatformTimestamp(data.updatedAt, "chatInfo.updatedAt");
    return {
      chatId: readString(data.chatId) || trimmedChatId,
      chatName: readString(data.chatName),
      agentKey: readString(data.agentKey),
      firstAgentKey: readString(data.firstAgentKey),
      firstAgentName: readString(data.firstAgentName),
      teamId: readString(data.teamId),
      source: readString(data.source),
      ...(createdAt !== undefined && createdAt !== null ? { createdAt } : {}),
      ...(updatedAt !== undefined && updatedAt !== null ? { updatedAt } : {}),
      lastRunId: readString(data.lastRunId),
      lastRunContent: readString(data.lastRunContent),
      runs: (data.runs ?? []).map((run, index) => {
        const startedAt = readOptionalPlatformTimestamp(run.startedAt, `chatInfo.runs[${index}].startedAt`);
        const completedAt = readOptionalPlatformTimestamp(run.completedAt, `chatInfo.runs[${index}].completedAt`);
        return {
          runId: readString(run.runId),
          ...(startedAt == null ? {} : { startedAt }),
          ...(completedAt == null ? {} : { completedAt }),
        };
      }),
      rawJson: JSON.stringify(data, null, 2),
    };
  }

  async searchChats(request: AssistantChatSearchRequest): Promise<AssistantChatSearchResponse> {
    const query = request?.query?.trim() ?? "";
    if (!query) {
      return { query: "", count: 0, results: [] };
    }
    const limit = Number.isFinite(Number(request.limit)) && Number(request.limit) > 0
      ? Math.floor(Number(request.limit))
      : undefined;
    const agentKey = request.agentKey?.trim() ?? "";
    const availability = await this.platform.resolvePlatform();
    if (!availability.ok) {
      throw new Error(availability.message);
    }
    const body = {
      query,
      ...(limit ? { limit } : {}),
      ...(agentKey ? { agentKey } : {})
    };
    const response = await this.platform.platformFetch(availability.baseUrl, "/api/chats/search", {
      method: "POST",
      headers: this.platform.jsonHeaders(availability.token),
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      throw new Error(await readErrorText(response));
    }
    const payload = unwrapApiResponse<PlatformChatSearchResponse>(await response.json());
    return mapChatSearchResponse(payload, query);
  }

  async deleteChat(chatId: string) {
    const trimmedChatId = chatId.trim();
    if (!trimmedChatId) {
      return { ok: false, message: t("assistant.chatIdRequired") };
    }
    const availability = await this.platform.resolvePlatform();
    if (!availability.ok) {
      return { ok: false, message: availability.message };
    }
    const response = await this.platform.platformFetch(availability.baseUrl, `/api/chat/delete?chatId=${encodeURIComponent(trimmedChatId)}`, {
      method: "POST",
      headers: this.platform.jsonHeaders(availability.token),
      body: JSON.stringify({})
    });
    if (!response.ok) {
      return { ok: false, message: await readErrorText(response) };
    }
    return { ok: true, message: t("assistant.chatDeleted") };
  }

  async markChatRead(chatId: string, runId?: string | null) {
    const trimmedChatId = chatId.trim();
    if (!trimmedChatId) {
      return { ok: false, message: t("assistant.chatIdRequired") };
    }
    const availability = await this.platform.resolvePlatform();
    if (!availability.ok) {
      return { ok: false, message: availability.message };
    }
    const response = await this.platform.platformFetch(availability.baseUrl, "/api/read", {
      method: "POST",
      headers: this.platform.jsonHeaders(availability.token),
      body: JSON.stringify({ chatId: trimmedChatId, runId: runId?.trim() || undefined })
    });
    if (!response.ok) {
      return { ok: false, message: await readErrorText(response) };
    }
    return { ok: true };
  }

  async markAgentChatsRead(agentKey: string) {
    const trimmedAgentKey = agentKey.trim();
    if (!trimmedAgentKey) {
      return { ok: false, message: t("assistant.agentKeyRequired") };
    }
    const availability = await this.platform.resolvePlatform();
    if (!availability.ok) {
      return { ok: false, message: availability.message };
    }
    const response = await this.platform.platformFetch(availability.baseUrl, "/api/read", {
      method: "POST",
      headers: this.platform.jsonHeaders(availability.token),
      body: JSON.stringify({ agentKey: trimmedAgentKey })
    });
    if (!response.ok) {
      return { ok: false, message: await readErrorText(response) };
    }
    return { ok: true, message: t("assistant.agentChatsMarkedRead") };
  }

  async renameChat(chatId: string, chatName: string) {
    const trimmedChatId = chatId.trim();
    const trimmedChatName = chatName.trim();
    if (!trimmedChatId || !trimmedChatName) {
      return { ok: false, message: t("assistant.chatIdOrNameRequired") };
    }
    const availability = await this.platform.resolvePlatform();
    if (!availability.ok) {
      return { ok: false, message: availability.message };
    }
    const response = await this.platform.platformFetch(availability.baseUrl, `/api/chat/rename?chatId=${encodeURIComponent(trimmedChatId)}`, {
      method: "POST",
      headers: this.platform.jsonHeaders(availability.token),
      body: JSON.stringify({ chatName: trimmedChatName })
    });
    if (!response.ok) {
      return { ok: false, message: await readErrorText(response) };
    }
    return { ok: true, message: t("assistant.chatRenamed") };
  }

  async archiveChat(chatId: string) {
    const trimmedChatId = chatId.trim();
    if (!trimmedChatId) {
      return { ok: false, message: t("assistant.chatIdRequired") };
    }
    const availability = await this.platform.resolvePlatform();
    if (!availability.ok) {
      return { ok: false, message: availability.message };
    }
    const response = await this.platform.platformFetch(availability.baseUrl, "/api/chat/archive", {
      method: "POST",
      headers: this.platform.jsonHeaders(availability.token),
      body: JSON.stringify({ chatIds: [trimmedChatId] })
    });
    if (!response.ok) {
      return { ok: false, message: await readErrorText(response) };
    }
    let payload: PlatformArchiveChatResponse;
    try {
      payload = unwrapApiResponse<PlatformArchiveChatResponse>(await response.json());
    }
    catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : t("assistant.chatArchiveFailed")
      };
    }
    const archiveResult = payload.results?.find((result) => result.chatId?.trim() === trimmedChatId) ?? payload.results?.[0];
    if (archiveResult?.success !== true) {
      return {
        ok: false,
        message: archiveResult?.error?.trim() || t("assistant.chatArchiveFailed")
      };
    }
    return { ok: true, message: t("assistant.chatArchived") };
  }
}
