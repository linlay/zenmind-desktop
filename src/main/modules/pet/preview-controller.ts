import type { DesktopPetPreviewPanel } from "../../../shared/contracts";
import { t } from "../../support/i18n/main-i18n";
import { isDesktopPetSupportedPlatform } from "./pet-settings";
import { normalizeDesktopPetAgentEvent } from "./desktop-pet-preview";
import { readEpochMillis } from "../../../shared/time-contract";

export const DESKTOP_PET_DONE_PREVIEW_FALLBACK = "暂无回复预览";

export const DESKTOP_PET_GENERIC_DONE_PREVIEWS = new Set([
  "思考中",
  "已完成",
  "回复已生成",
  "正在生成回复",
  "生成完成",
  "生成完成。",
  "打开对话查看完整回复",
  DESKTOP_PET_DONE_PREVIEW_FALLBACK
]);

export function normalizeDesktopPetReplyPreview(value: unknown) {
  return typeof value === "string" ? value.replace(/\s+/gu, " ").trim() : "";
}

export function getUsableDesktopPetReplyPreview(value: unknown) {
  const preview = normalizeDesktopPetReplyPreview(value);
  return preview && !DESKTOP_PET_GENERIC_DONE_PREVIEWS.has(preview) ? preview : "";
}

export function getDesktopPetStatusPatchFromPreview(panel: DesktopPetPreviewPanel | null | undefined) {
  if (!panel) {
    return null;
  }
  if (panel.status === "waiting") {
    return {
      status: "awaiting" as const,
      hint: t("desktopPet.status.thinking"),
      chatId: panel.chatId,
      unreadCount: 0
    };
  }
  if (panel.status === "done") {
    return {
      status: "done" as const,
      hint: panel.summary,
      chatId: panel.chatId,
      unreadCount: 0
    };
  }
  if (panel.status === "error") {
    return {
      status: "error" as const,
      hint: t("desktopPet.status.error"),
      chatId: panel.chatId,
      unreadCount: 0
    };
  }
  if (panel.status === "stopped") {
    return {
      status: "idle" as const,
      hint: "",
      chatId: panel.chatId,
      unreadCount: 0
    };
  }
  return {
    status: "running" as const,
    hint: t("desktopPet.status.thinking"),
    chatId: panel.chatId,
    unreadCount: 0
  };
}

export interface DesktopPetPreviewControllerOptions {
  platform: string;
  previewProjector: any;
  dismissalTracker: any;
  activeRunTracker: any;
  getAgentStatus: () => any;
  scheduleIdleReset: (holdMs: number, force: boolean) => void;
  clearIdleResetTimer: () => void;
  refreshState: (patch?: any) => void;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
}

export interface DesktopPetPreviewController {
  clearRefreshTimer(): void;
  clearPreview(): void;
  getPanel(): any;
  setExpanded(expanded: boolean): void;
  ingestAgentEvent(event: any, meta?: { source?: string; transportMode?: string }): void;
  refreshCompletedPreviewFromAgentStatus(status: any): boolean;
  dismissPreview(): { ok: boolean };
}

export function createDesktopPetPreviewController(
  options: DesktopPetPreviewControllerOptions
): DesktopPetPreviewController {
  let previewRefreshTimer: any = null;

  const runSetTimeout = options.setTimeout || setTimeout;
  const runClearTimeout = options.clearTimeout || clearTimeout;

  function clearRefreshTimer() {
    if (previewRefreshTimer) {
      runClearTimeout(previewRefreshTimer);
      previewRefreshTimer = null;
    }
  }

  function clearPreview() {
    options.previewProjector.clear();
  }

  function getPanel() {
    return options.previewProjector.getPanel();
  }

  function setExpanded(expanded: boolean) {
    options.previewProjector.setExpanded(expanded);
  }

  function refreshPreviewThrottled() {
    if (previewRefreshTimer) {
      return;
    }
    previewRefreshTimer = runSetTimeout(() => {
      previewRefreshTimer = null;
      const patch = getDesktopPetStatusPatchFromPreview(options.previewProjector.getPanel());
      options.refreshState(patch ?? {});
    }, 120);
  }

  function ingestAgentEvent(event: any, meta: { source?: string; transportMode?: string } = {}) {
    if (!isDesktopPetSupportedPlatform(options.platform)) {
      return;
    }
    const normalizedEvent = normalizeDesktopPetAgentEvent(event);
    if (normalizedEvent?.type === "request.query" || normalizedEvent?.type === "run.start") {
      options.dismissalTracker.clear(normalizedEvent.chatId, normalizedEvent.runId);
    }
    options.activeRunTracker.update(normalizedEvent);
    if (options.dismissalTracker.isDismissedCompletionEvent(normalizedEvent)) {
      return;
    }
    const result = options.previewProjector.ingest(normalizedEvent ?? event, meta);
    if (!result.changed) {
      return;
    }

    if (result.holdMs) {
      options.scheduleIdleReset(result.holdMs, true);
    } else {
      options.clearIdleResetTimer();
    }

    if (result.refresh === "throttled") {
      refreshPreviewThrottled();
      return;
    }

    clearRefreshTimer();
    const patch = getDesktopPetStatusPatchFromPreview(result.panel);
    options.refreshState(patch ?? {});
  }

  function refreshCompletedPreviewFromAgentStatus(status: any) {
    if (!status || status.stale || status.presence !== "away") {
      return false;
    }
    if (options.dismissalTracker.isDismissedChat(status.chatId)) {
      return false;
    }
    const replyPreview = getUsableDesktopPetReplyPreview(status.latestPreview);
    const timestamp = readEpochMillis(status.updatedAt);
    if (!replyPreview || timestamp === undefined) {
      return false;
    }
    const panel = options.previewProjector.getPanel();
    if (!panel || panel.status !== "done") {
      return false;
    }
    if (panel.chatId && status.chatId && panel.chatId !== status.chatId) {
      return false;
    }
    if (
      normalizeDesktopPetReplyPreview(panel.title) === replyPreview &&
      normalizeDesktopPetReplyPreview(panel.summary) === replyPreview
    ) {
      return false;
    }

    ingestAgentEvent({
      runId: panel.runId,
      chatId: panel.chatId ?? status.chatId,
      type: "run.complete",
      createdAt: timestamp,
      message: replyPreview
    }, {
      source: "agent-platform-status",
      transportMode: "snapshot"
    });
    return true;
  }

  function dismissPreview() {
    if (!isDesktopPetSupportedPlatform(options.platform)) {
      return { ok: false };
    }
    options.clearIdleResetTimer();
    clearRefreshTimer();
    options.dismissalTracker.rememberFrom(options.previewProjector.getPanel(), options.getAgentStatus());
    options.previewProjector.clear();
    options.refreshState({
      status: "idle",
      hint: "",
      unreadCount: 0,
      chatId: null
    });
    return { ok: true };
  }

  return {
    clearRefreshTimer,
    clearPreview,
    getPanel,
    setExpanded,
    ingestAgentEvent,
    refreshCompletedPreviewFromAgentStatus,
    dismissPreview
  };
}
