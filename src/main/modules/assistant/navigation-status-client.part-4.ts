import fs from "node:fs";

import { execFile } from "node:child_process";

import type { App } from "electron";

import type {
  AgentAuthIssueResult,
  AssistantChatSortMode,
  AssistantAwaitingMode,
  AssistantNavAgentIcon,
  AssistantNavAgentItem,
  AssistantNavAgentItemsResult,
  AssistantNavChatItem,
  AssistantNavigationLiveFrame,
  AssistantNavigationPushEvent,
  AssistantNavigationLiveStatus,
  ServiceId,
  ServiceState
} from "../../../shared/contracts";

import {
  readDesktopProfileFromRoot,
  updateDesktopProfileInRoot,
} from "../../infrastructure/filesystem/profile-store";

import { getDesktopConfigRoot } from "../../infrastructure/filesystem/user-paths";

import {
  isTimeContractViolation,
  isAgentPlatformEpochMilliseconds,
  parseOptionalNullableAgentPlatformEpochMillis,
  requireAgentPlatformEpochMillis,
  requireEpochMillis,
} from "../../../shared/time-contract";

import {
  readAgentPlatformPushEpochMillis,
  validateAgentPlatformPushTimeContract,
} from "../../../shared/agent-platform-push-time-contract";

import { t } from "../../support/i18n/main-i18n";

import {
  AGENT_PLATFORM_KNOWN_PUSH_TYPES,
  RealtimeBroker,
} from "../agent-platform";

import type { AgentPlatformRealtimeFrame } from "../agent-platform";

import { AGENT_PLATFORM_SERVICE_ID, ASSISTANT_NAVIGATION_WS_SOURCE, AssistantNavigationRecordedRuntimeStatusPush, IGNORED_PUSH_TYPES, JOURNALED_NAVIGATION_PUSH_TYPES, NAVIGATION_AGENT_CHAT_LIMIT, NAVIGATION_AGENT_HISTORY_LIMIT, NAVIGATION_CHAT_AGENT_MODE, NAVIGATION_CHAT_LIMIT, NAVIGATION_CHAT_PROBE_LIMIT, NAVIGATION_LIVE_FRAME_LIMIT, NAVIGATION_REFRESH_DEBOUNCE_MS, NAVIGATION_UNAVAILABLE_RETRY_MS, NavigationPushEvent, NavigationPushFrame, PlatformChatOrder, createRedactedWsEndpoint, nowEpochMillis, toText, unwrapApiResponse } from "./navigation-status-client.part-1";

import { AssistantNavigationChatOrderSnapshot, AssistantNavigationChatsSnapshot, buildAssistantNavigationChatsSnapshotFromPlatform, createChatRuntimeStatusPatch, readPushChatId, toPushEvent } from "./navigation-status-client.part-2";

import { applyAssistantNavigationChatPush, applyAssistantNavigationPush, readAssistantNavigationActivityAgentsFromPlatform, readAssistantNavigationAgentsFromPlatform } from "./navigation-status-client.part-3";

export class AssistantNavigationStatusClient {
  private readonly realtimeBroker: RealtimeBroker;
  private readonly ownsRealtimeBroker: boolean;
  private unsubscribePush: (() => void) | null = null;
  private wsRequestSequence = 0;
  private stopped = false;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshInFlight: Promise<AssistantNavAgentItemsResult> | null = null;
  private refreshRequestedWhileInFlight = false;
  private runtimeStatusPushSequence = 0;
  private runtimeStatusPushes: AssistantNavigationRecordedRuntimeStatusPush[] = [];
  private latestResult: AssistantNavAgentItemsResult = {
    ok: false,
    items: [],
    activityItems: [],
    chatItems: [],
    chatItemsHasMore: false,
    chatSortMode: "recent",
    chatOrderingSupported: false,
    message: t("assistant.navigationStatusUninitialized"),
    updatedAt: nowEpochMillis()
  };
  private liveStatus: AssistantNavigationLiveStatus = {
    phase: "idle",
    source: ASSISTANT_NAVIGATION_WS_SOURCE,
    endpoint: null,
    connectedAt: null,
    lastMessageAt: null,
    lastRefreshAt: null,
    lastPushType: null,
    lastError: null,
    recentFrames: [],
  };
  constructor(private readonly options: {
    app: App;
    getServiceState: (app: App, serviceId: ServiceId) => Promise<ServiceState>;
    issueAccessToken: (app: App, reason: "missing" | "unauthorized") => Promise<AgentAuthIssueResult>;
    realtimeBroker?: RealtimeBroker;
    onSnapshot: (result: AssistantNavAgentItemsResult) => void;
    onPushEvent?: (event: AssistantNavigationPushEvent) => void;
    onDebug?: (message: string) => void;
  }) {
    this.ownsRealtimeBroker = !options.realtimeBroker;
    this.realtimeBroker = options.realtimeBroker ?? new RealtimeBroker({
      app: options.app,
      issueAccessToken: options.issueAccessToken,
      getDesktopDeviceId: () => "desktop-main",
      onDiagnostic: options.onDebug,
    });
  }

  start() {
    this.stopped = false;
    this.runtimeStatusPushSequence = 0;
    this.runtimeStatusPushes = [];
    this.updateLiveStatus({
      phase: "idle",
      endpoint: null,
      connectedAt: null,
      lastMessageAt: null,
      lastRefreshAt: null,
      lastPushType: null,
      lastError: null,
      recentFrames: [],
    });
    this.scheduleRefresh(0);
  }

  stop() {
    this.stopped = true;
    this.refreshRequestedWhileInFlight = false;
    this.runtimeStatusPushes = [];
    this.clearTimers();
    this.updateLiveStatus({
      phase: "idle",
      endpoint: null,
      connectedAt: null,
      lastMessageAt: null,
      lastRefreshAt: null,
      lastPushType: null,
      lastError: null,
      recentFrames: [],
    });
    this.unsubscribePush?.();
    this.unsubscribePush = null;
    this.realtimeBroker.cleanupConsumer("assistant-navigation");
    if (this.ownsRealtimeBroker) {
      this.realtimeBroker.dispose();
    }
  }

  getSnapshot() {
    return this.latestResult;
  }

  getLiveStatus(): AssistantNavigationLiveStatus {
    const brokerState = this.realtimeBroker.getConnectionState();
    const reflectBrokerDisconnect = this.liveStatus.phase === "connected" &&
      (brokerState.phase === "reconnecting" || brokerState.phase === "error" || brokerState.phase === "closed");
    return {
      ...this.liveStatus,
      ...(reflectBrokerDisconnect
        ? {
            phase: brokerState.phase === "reconnecting" ? "reconnecting" as const : "error" as const,
            lastError: brokerState.lastError ?? this.liveStatus.lastError,
          }
        : {}),
      recentFrames: this.liveStatus.recentFrames.map((frame) => ({ ...frame })),
    };
  }

  scheduleRefresh(delayMs = NAVIGATION_REFRESH_DEBOUNCE_MS) {
    if (this.stopped) {
      return;
    }
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refreshNow().catch((error) => {
        this.options.onDebug?.(error instanceof Error ? error.message : String(error));
      });
    }, Math.max(0, delayMs));
  }

  async refreshNow(): Promise<AssistantNavAgentItemsResult> {
    if (this.refreshInFlight) {
      this.refreshRequestedWhileInFlight = true;
      return this.refreshInFlight;
    }
    const refresh = this.performRefreshNow();
    this.refreshInFlight = refresh;
    try {
      return await refresh;
    } finally {
      if (this.refreshInFlight === refresh) {
        this.refreshInFlight = null;
      }
      if (this.refreshRequestedWhileInFlight && !this.stopped) {
        this.refreshRequestedWhileInFlight = false;
        this.scheduleRefresh(0);
      }
    }
  }

  private async performRefreshNow(): Promise<AssistantNavAgentItemsResult> {
    if (this.stopped) {
      return this.latestResult;
    }
    const runtimeStatusSequenceAtStart = this.runtimeStatusPushSequence;
    this.updateLiveStatus({ lastRefreshAt: nowEpochMillis() });
    try {
      const serviceState = await this.options.getServiceState(this.options.app, AGENT_PLATFORM_SERVICE_ID);
      const baseUrl = serviceState.status === "running" ? serviceState.healthMeta.webUrl.trim() : "";
      if (!baseUrl) {
        const message = t("agentPlatform.notRunning");
        this.updateLiveStatus({
          phase: "unavailable",
          endpoint: null,
          lastError: message,
        });
        this.setSnapshot({
          ok: false,
          items: [],
          chatItems: [],
          chatItemsHasMore: false,
          message,
          updatedAt: nowEpochMillis()
        });
        this.scheduleRefresh(NAVIGATION_UNAVAILABLE_RETRY_MS);
        return this.latestResult;
      }

      const tokenResult = await this.options.issueAccessToken(this.options.app, "missing");
      const token = tokenResult.ok ? tokenResult.token.trim() : "";
      if (!token) {
        const message = tokenResult.message || t("agentPlatform.accessTokenMissing");
        this.updateLiveStatus({
          phase: "unavailable",
          endpoint: createRedactedWsEndpoint(baseUrl),
          lastError: message,
        });
        this.setSnapshot({
          ok: false,
          items: [],
          chatItems: [],
          chatItemsHasMore: false,
          message,
          updatedAt: nowEpochMillis()
        });
        this.scheduleRefresh(NAVIGATION_UNAVAILABLE_RETRY_MS);
        return this.latestResult;
      }

      const items = await readAssistantNavigationAgentsFromPlatform(baseUrl, token);
      const activityItems = await readAssistantNavigationActivityAgentsFromPlatform(
        baseUrl,
        token,
        NAVIGATION_AGENT_CHAT_LIMIT,
        items
      );
      await this.connectRealtime(baseUrl, token);
      const [chatSnapshot, chatOrderSnapshot] = await Promise.all([
        this.requestNavigationChats(baseUrl, token),
        this.requestNavigationChatOrder(baseUrl, token),
      ]);
      if (chatOrderSnapshot.chatOrderingSupported) {
        this.cacheChatSortMode(chatOrderSnapshot.chatSortMode);
      }
      const refreshedResult = this.replayRuntimeStatusPushesSince({
        ok: true,
        items,
        activityItems,
        ...chatSnapshot,
        ...chatOrderSnapshot,
        message: t("assistant.navigationStatusRead"),
        updatedAt: nowEpochMillis()
      }, runtimeStatusSequenceAtStart);
      this.setSnapshot(refreshedResult);
      this.runtimeStatusPushes = this.runtimeStatusPushes.filter(
        (recorded) => recorded.sequence > runtimeStatusSequenceAtStart,
      );
      return this.latestResult;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.onDebug?.(message);
      this.updateLiveStatus({
        phase: this.realtimeBroker.getConnectionPhase() === "reconnecting" ? "reconnecting" : "error",
        lastError: message,
      });
      if (isTimeContractViolation(error)) {
        this.scheduleRefresh(NAVIGATION_UNAVAILABLE_RETRY_MS);
        throw error;
      }
      this.setSnapshot({
        ok: false,
        items: [],
        chatItems: [],
        chatItemsHasMore: false,
        message,
        updatedAt: nowEpochMillis()
      });
      this.scheduleRefresh(NAVIGATION_UNAVAILABLE_RETRY_MS);
      return this.latestResult;
    }
  }

  private recordRuntimeStatusPush(
    frame: NavigationPushFrame,
    event: NavigationPushEvent,
  ) {
    if (
      !createChatRuntimeStatusPatch(event) &&
      !JOURNALED_NAVIGATION_PUSH_TYPES.has(event.type)
    ) {
      return;
    }
    this.runtimeStatusPushSequence += 1;
    this.runtimeStatusPushes.push({
      sequence: this.runtimeStatusPushSequence,
      frame,
    });
  }

  private replayRuntimeStatusPushesSince(
    result: AssistantNavAgentItemsResult,
    sequence: number,
  ) {
    let nextResult = result;
    for (const recorded of this.runtimeStatusPushes) {
      if (recorded.sequence <= sequence) {
        continue;
      }
      const next = applyAssistantNavigationPush(nextResult.items, recorded.frame);
      const nextActivity = applyAssistantNavigationPush(
        nextResult.activityItems ?? [],
        recorded.frame,
      );
      const nextChats = applyAssistantNavigationChatPush(
        nextResult.chatItems,
        recorded.frame,
      );
      if (!next.changed && !nextActivity.changed && !nextChats.changed) {
        continue;
      }
      nextResult = {
        ...nextResult,
        items: next.items,
        activityItems: nextActivity.items,
        chatItems: nextChats.items,
      };
    }
    return nextResult;
  }

  private setSnapshot(result: AssistantNavAgentItemsResult) {
    this.latestResult = result;
    this.options.onSnapshot(result);
  }

  private updateLiveStatus(update: Partial<Omit<AssistantNavigationLiveStatus, "source">>) {
    this.liveStatus = {
      ...this.liveStatus,
      ...update,
      source: ASSISTANT_NAVIGATION_WS_SOURCE,
    };
  }

  private recordLiveFrame(frame: Omit<AssistantNavigationLiveFrame, "at">) {
    const recentFrames = [
      ...this.liveStatus.recentFrames,
      { ...frame, at: nowEpochMillis() },
    ].slice(-NAVIGATION_LIVE_FRAME_LIMIT);
    this.updateLiveStatus({ recentFrames });
  }

  private async connectRealtime(baseUrl: string, token: string): Promise<void> {
    this.updateLiveStatus({
      phase: "connecting",
      endpoint: createRedactedWsEndpoint(baseUrl),
      lastError: null,
    });
    this.recordLiveFrame({ direction: "connection", kind: "connecting", type: null });
    try {
      await this.realtimeBroker.ensureConnected(baseUrl, token);
    } catch (error) {
      this.recordLiveFrame({ direction: "connection", kind: "error", type: null });
      throw error;
    }
    if (!this.unsubscribePush) {
      this.unsubscribePush = this.realtimeBroker.subscribePush({
        types: [...AGENT_PLATFORM_KNOWN_PUSH_TYPES],
        kind: "internal",
        consumerId: "assistant-navigation",
        onPush: (frame) => this.handleRealtimeFrame(frame),
      });
    }
    this.recordLiveFrame({ direction: "connection", kind: "connected", type: null });
    this.updateLiveStatus({
      phase: "connected",
      connectedAt: nowEpochMillis(),
      lastError: null,
    });
  }

  private async requestNavigationChats(
    baseUrl: string,
    token: string,
  ): Promise<AssistantNavigationChatsSnapshot> {
    const id = `desktop-nav-chats-${++this.wsRequestSequence}`;
    const frame = await new Promise<NavigationPushFrame>((resolve, reject) => {
      void this.realtimeBroker.forwardRequest({
        baseUrl,
        token,
        localId: id,
        consumerId: "assistant-navigation",
        type: "/api/chats",
        payload: {
          mode: NAVIGATION_CHAT_AGENT_MODE,
          limit: NAVIGATION_CHAT_PROBE_LIMIT,
        },
        onFrame: (response) => {
          this.updateLiveStatus({ lastMessageAt: nowEpochMillis() });
          this.recordLiveFrame({
            direction: "inbound",
            kind: toText(response.frame) === "error" ? "error" : "response",
            type: toText(response.type) || null,
          });
          if (toText(response.frame) === "error") {
            reject(new Error(toText(response.msg) || "agent-platform realtime request failed"));
            return;
          }
          resolve(response as NavigationPushFrame);
        },
        onError: reject,
      }).catch((error) => reject(error instanceof Error ? error : new Error(String(error))));
      this.recordLiveFrame({ direction: "outbound", kind: "request", type: "/api/chats" });
    });
    return buildAssistantNavigationChatsSnapshotFromPlatform(
      unwrapApiResponse<unknown[]>(frame),
    );
  }

  private async requestNavigationChatOrder(
    baseUrl: string,
    token: string,
  ): Promise<AssistantNavigationChatOrderSnapshot> {
    const id = `desktop-nav-chat-order-${++this.wsRequestSequence}`;
    try {
      const frame = await new Promise<NavigationPushFrame>((resolve, reject) => {
        void this.realtimeBroker.forwardRequest({
          baseUrl,
          token,
          localId: id,
          consumerId: "assistant-navigation",
          type: "/api/chats/order",
          payload: {},
          onFrame: (response) => {
            this.updateLiveStatus({ lastMessageAt: nowEpochMillis() });
            this.recordLiveFrame({
              direction: "inbound",
              kind: toText(response.frame) === "error" ? "error" : "response",
              type: toText(response.type) || null,
            });
            if (toText(response.frame) === "error") {
              reject(new Error(toText(response.msg) || "chat ordering is unavailable"));
              return;
            }
            resolve(response as NavigationPushFrame);
          },
          onError: reject,
        }).catch((error) => reject(error instanceof Error ? error : new Error(String(error))));
        this.recordLiveFrame({ direction: "outbound", kind: "request", type: "/api/chats/order" });
      });
      const data = unwrapApiResponse<PlatformChatOrder>(frame);
      const sortMode = toText(data?.sortMode);
      if (sortMode !== "recent" && sortMode !== "manual") {
        throw new Error("agent-platform returned an invalid chat sort mode");
      }
      if (data?.updatedAt !== undefined && data.updatedAt !== null) {
        requireAgentPlatformEpochMillis(
          data.updatedAt,
          "navigation.chatOrder.updatedAt",
        );
      }
      return {
        chatSortMode: sortMode,
        chatOrderingSupported: true,
      };
    } catch (error) {
      this.options.onDebug?.(
        `[chat-order] unavailable; using recent: ${error instanceof Error ? error.message : String(error)}`,
      );
      return {
        chatSortMode: "recent",
        chatOrderingSupported: false,
      };
    }
  }

  private cacheChatSortMode(sortMode: AssistantChatSortMode) {
    const profileRoot = getDesktopConfigRoot(this.options.app);
    const current = readDesktopProfileFromRoot(profileRoot);
    if (current.navigation.chatSortMode === sortMode) {
      return;
    }
    updateDesktopProfileInRoot(profileRoot, {
      navigation: { chatSortMode: sortMode },
    });
  }

  private handleRealtimeFrame(input: AgentPlatformRealtimeFrame) {
    if (this.stopped) {
      return;
    }
    const frame = input as NavigationPushFrame;
    this.updateLiveStatus({ lastMessageAt: nowEpochMillis() });
    const frameKind = toText(frame.frame);
    const frameType = toText(frame.type) || null;
    const liveFrameKind = frameKind === "response"
      ? "response"
      : frameKind === "error"
        ? "error"
        : frameKind === "push"
          ? "push"
          : "invalid";
    this.recordLiveFrame({ direction: "inbound", kind: liveFrameKind, type: frameType });
    if (frameKind !== "push") {
      return;
    }
    const event = toPushEvent(frame);
    this.updateLiveStatus({ lastPushType: event.type || null });
    const invalidTimeField = validateAgentPlatformPushTimeContract(event.type, event);
    if (invalidTimeField) {
      this.options.onDebug?.(
        `time_contract_violation: navigation.push.${event.type}.${invalidTimeField} violates the push time contract`,
      );
      this.scheduleRefresh();
      return;
    }
    if (IGNORED_PUSH_TYPES.has(event.type)) {
      return;
    }
    this.recordRuntimeStatusPush(frame, event);
    const protocolType = frameType || (event.type === "run.start"
      ? "run.started"
      : event.type === "run.complete"
        ? "run.finished"
        : toText(event.type));
    const semanticTime = readAgentPlatformPushEpochMillis(event.type, event);
    this.options.onPushEvent?.({
      frame: "push",
      type: protocolType,
      chatId: readPushChatId(event) || null,
      runId: toText(event.runId) || null,
      status: toText(event.status) || null,
      finishReason: toText(event.finishReason) || null,
      ...(protocolType === "run.started" && semanticTime !== undefined
        ? { startedAt: semanticTime }
        : {}),
      ...(protocolType === "run.finished" && semanticTime !== undefined
        ? { finishedAt: semanticTime }
        : {})
    });
    const next = applyAssistantNavigationPush(this.latestResult.items, frame);
    const hasActivityItems = Array.isArray(this.latestResult.activityItems);
    const nextActivity = hasActivityItems
      ? applyAssistantNavigationPush(this.latestResult.activityItems ?? [], frame)
      : next;
    const nextChats = applyAssistantNavigationChatPush(this.latestResult.chatItems, frame);
    if (next.changed || nextActivity.changed || nextChats.changed) {
      this.setSnapshot({
        ok: true,
        items: next.items,
        activityItems: nextActivity.items,
        chatItems: nextChats.items,
        chatItemsHasMore: this.latestResult.chatItemsHasMore,
        chatSortMode: this.latestResult.chatSortMode ?? "recent",
        chatOrderingSupported: this.latestResult.chatOrderingSupported === true,
        message: t("assistant.navigationNotificationSynced"),
        updatedAt: nowEpochMillis()
      });
    }
    const isReadProjectionPush = JOURNALED_NAVIGATION_PUSH_TYPES.has(event.type);
    if (isReadProjectionPush) {
      // Read state is a push-owned projection. A successfully applied or
      // recognized stale event must not start a snapshot race; only a wholly
      // missing target needs server calibration.
      if (next.shouldRefresh && nextActivity.shouldRefresh && nextChats.shouldRefresh) {
        this.scheduleRefresh();
      }
      return;
    }

    // A new chat cannot be optimistically inserted into the global Chats list:
    // the server owns its ordering and visible cutoff. Refresh it immediately
    // so the route mirrored from agent-webclient can select the new list item.
    this.scheduleRefresh(event.type === "chat.created" ? 0 : undefined);
  }

  private clearTimers() {
    for (const timer of [this.refreshTimer]) {
      if (timer) {
        clearTimeout(timer);
      }
    }
    this.refreshTimer = null;
  }
}

export const __testInternals = {
  NAVIGATION_AGENT_CHAT_LIMIT,
  NAVIGATION_AGENT_HISTORY_LIMIT,
  NAVIGATION_CHAT_LIMIT,
  toPushEvent
};
