import type {
  AssistantEvent,
  AssistantStartRunRequest,
  AssistantStartRunResult,
  AssistantStopRunResult,
  AssistantSubmitAwaitingRequest,
  AssistantSubmitAwaitingResult,
  AssistantTextCompletionResult
} from "../../../shared/contracts";
import { isTimeContractViolation } from "../../../shared/time-contract";
import { t } from "../../support/i18n/main-i18n";
import { readAssistantEventOutputText, readFinalAssistantTextFromChatFile } from "./assistant-output-text";
import type { AttachmentUploader } from "./attachment-upload";
import { ActiveAssistantRun, AssistantRunWakeLock } from "./bridge-contracts";
import {
  createChatId,
  createRunId,
  normalizeAssistantAccessLevel,
  normalizeAssistantPermissionMode,
  nowEpochMillis
} from "./bridge-values";
import type { PlatformClient } from "./platform-client";
import { isAssistantRunTerminalEvent, normalizePlatformEvent } from "./platform-event-normalizer";
import { readErrorText } from "./platform-http-response";
import type { RealtimeQueryHandle, RealtimeBroker } from "./realtime/realtime-broker";
import { framePayload, frameError, readText } from "./realtime/realtime-broker.shared";

/** Owns Assistant transactions and their wake-lock lifetime. */
export class AssistantRunController {
  private readonly activeRuns = new Map<string, ActiveAssistantRun>();
  private unsubscribeBackgroundWatch: (() => void) | null = null;
  private disposed = false;
  constructor(
    private readonly platform: Pick<PlatformClient, "resolvePlatform" | "platformFetch" | "jsonHeaders">,
    private readonly realtimeBroker: Pick<RealtimeBroker, "query" | "dispose" | "forwardRequest" | "subscribePush" | "subscribeConnection">,
    private readonly ownsRealtimeBroker: boolean,
    private readonly attachments: Pick<AttachmentUploader, "uploadAttachments">,
    private readonly options: { onEvent: (event: AssistantEvent) => void; wakeLock?: AssistantRunWakeLock; resolveChatFile: (chatId: string) => string }
  ) {}

  private acquireWakeLockForActiveRuns() {
    if (this.activeRuns.size === 1) {
      this.options.wakeLock?.acquire();
    }
  }

  private releaseWakeLockIfIdle() {
    if (this.activeRuns.size === 0) {
      this.options.wakeLock?.release();
    }
  }

  async startRun(request: AssistantStartRunRequest): Promise<AssistantStartRunResult> {
    const message = request.message.trim();
    const chatId = request.chatId?.trim() || createChatId();
    const runId = request.runId?.trim() || createRunId();
    if (!message) {
      return {
        ok: false,
        runId: "",
        chatId,
        message: t("assistant.messageRequired")
      };
    }
    if (this.disposed) {
      return {
        ok: false,
        runId,
        chatId,
        message: "Assistant bridge is disposed"
      };
    }
    const availability = await this.platform.resolvePlatform();
    if (!availability.ok) {
      return {
        ok: false,
        runId,
        chatId,
        message: availability.message
      };
    }
    const existing = this.activeRuns.get(runId);
    if (existing) {
      if (existing.chatId !== chatId || !existing.acceptance) {
        return {
          ok: false,
          runId,
          chatId,
          message: "runId is already active with a different Assistant transaction"
        };
      }
      return existing.acceptance;
    }
    const controller = new AbortController();
    let resolveAcceptance!: (result: AssistantStartRunResult) => void;
    const acceptance = new Promise<AssistantStartRunResult>((resolve) => {
      resolveAcceptance = resolve;
    });
    const activeRun: ActiveAssistantRun = {
      controller,
      chatId,
      agentKey: request.agentKey?.trim() || "",
      baseUrl: availability.baseUrl,
      token: availability.token,
      acceptance,
    };
    this.activeRuns.set(runId, activeRun);
    this.acquireWakeLockForActiveRuns();
    void this.runQuery(availability.baseUrl, availability.token, request, {
      chatId,
      runId,
      activeRun,
      onAcceptance: resolveAcceptance,
    });
    return acceptance;
  }

  /**
   * Starts a Run that keeps executing in the Platform without a live Run
   * stream. Callers follow it through run.* Push; a surface that wants the
   * output attaches by runId. Acceptance is the only thing awaited here.
   */
  async startBackgroundRun(request: AssistantStartRunRequest): Promise<AssistantStartRunResult> {
    const message = request.message.trim();
    const chatId = request.chatId?.trim() || createChatId();
    const runId = request.runId?.trim() || createRunId();
    if (!message) {
      return { ok: false, runId: "", chatId, message: t("assistant.messageRequired") };
    }
    if (this.disposed) {
      return { ok: false, runId, chatId, message: "Assistant bridge is disposed" };
    }
    const availability = await this.platform.resolvePlatform();
    if (!availability.ok) {
      return { ok: false, runId, chatId, message: availability.message };
    }
    const existing = this.activeRuns.get(runId);
    if (existing) {
      if (existing.chatId !== chatId || !existing.acceptance) {
        return { ok: false, runId, chatId, message: "runId is already active with a different Assistant transaction" };
      }
      return existing.acceptance;
    }
    const activeRun: ActiveAssistantRun = {
      controller: new AbortController(),
      chatId,
      agentKey: request.agentKey?.trim() || "",
      baseUrl: availability.baseUrl,
      token: availability.token,
      background: "starting",
    };
    activeRun.acceptance = this.submitBackgroundQuery(availability.baseUrl, availability.token, request, { chatId, runId, activeRun });
    this.activeRuns.set(runId, activeRun);
    this.acquireWakeLockForActiveRuns();
    this.watchBackgroundRuns();
    const result = await activeRun.acceptance;
    // A rejected or unconfirmed start holds no Run lifetime. An unconfirmed
    // Run that did start is still converged by the caller through Push.
    if (!result.ok && this.activeRuns.get(runId) === activeRun) {
      this.activeRuns.delete(runId);
      this.releaseWakeLockIfIdle();
    }
    if (result.ok) {
      activeRun.background = "running";
    }
    return result;
  }

  private async submitBackgroundQuery(baseUrl: string, token: string, request: AssistantStartRunRequest, run: {
    chatId: string;
    runId: string;
    activeRun: ActiveAssistantRun;
  }): Promise<AssistantStartRunResult> {
    const failed = (message: string): AssistantStartRunResult => ({ ok: false, runId: run.runId, chatId: run.chatId, message });
    const requestId = request.requestId?.trim() || run.runId;
    // A stop that lands between here and acceptance is deliberately not
    // handled: background starts are unattended, and an upload that precedes a
    // skipped query is bound only to the Chat. Such a Run simply starts.
    // Settles once the request frame was written (true) or was never sent (false).
    let delivered: Promise<boolean> = Promise.resolve(false);
    try {
      const references = await this.attachments.uploadAttachments(baseUrl, token, run.chatId, run.runId, request.attachments ?? [], false);
      const accessLevel = normalizeAssistantAccessLevel(request.accessLevel);
      const frame = await new Promise<Parameters<Parameters<RealtimeBroker["forwardRequest"]>[0]["onFrame"]>[0]>((resolve, reject) => {
        delivered = this.realtimeBroker.forwardRequest({
          baseUrl,
          token,
          lane: "primary",
          localId: requestId,
          consumerId: `assistant:${request.source || "copilot"}:${requestId}:background`,
          type: "/api/query",
          payload: {
            requestId,
            runId: run.runId,
            chatId: run.chatId,
            agentKey: request.agentKey?.trim() || undefined,
            message: request.message.trim(),
            ...(request.mustUseSkills?.length ? { mustUseSkills: request.mustUseSkills } : {}),
            ...(accessLevel ? { accessLevel } : {}),
            references,
            params: {
              desktop: {
                source: request.source || "copilot",
                action: request.action || "chat",
                pageContext: request.pageContext ?? null
              }
            },
            detached: true
          },
          onFrame: resolve,
          onError: reject,
        }).then(() => true, (error) => { reject(error); return false; });
      });
      if (frame.frame === "error") {
        return failed(frameError(frame).message);
      }
      const accepted = framePayload(frame);
      // An older Platform ignores `detached` and answers with a Run stream.
      if (frame.frame !== "response" || accepted.accepted !== true) {
        return failed("protocol_error: Agent Platform did not acknowledge the detached query");
      }
      if (readText(accepted.runId) !== run.runId || readText(accepted.chatId) !== run.chatId) {
        this.bestEffortInterrupt(readText(accepted.runId) || run.runId, run.activeRun, "Desktop Assistant run identity mismatch.");
        return failed("protocol_error: detached query returned a different Run identity");
      }
      run.activeRun.agentKey = readText(accepted.agentKey) || run.activeRun.agentKey;
      return {
        ok: true,
        runId: run.runId,
        chatId: run.chatId,
        message: t("agentPlatform.runSubmitted"),
        permissionMode: normalizeAssistantPermissionMode(request.permissionMode),
        fullAccessRemainingMs: 0
      };
    }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Once the request left this process, a transport failure or timeout
      // does not prove rejection; report it like a stream query lost before acceptance.
      return failed(await delivered ? `connection_lost_before_acceptance: ${message}` : message);
    }
  }

  private watchBackgroundRuns() {
    if (this.unsubscribeBackgroundWatch) {
      return;
    }
    const unsubscribePush = this.realtimeBroker.subscribePush({
      types: ["run.finished"],
      kind: "internal",
      consumerId: "assistant:background-runs",
      onPush: (frame) => {
        const runId = readText(framePayload(frame).runId);
        if (this.activeRuns.get(runId)?.background) {
          this.releaseBackgroundRun(runId);
        }
      },
    });
    // Push is not replayed: a terminal Push missed while Primary was down is
    // recovered by checking each background Run once the lane is back.
    let connected = true;
    const unsubscribeConnection = this.realtimeBroker.subscribeConnection({
      lane: "primary",
      consumerId: "assistant:background-runs",
      onState: (state) => {
        const wasConnected = connected;
        connected = state.phase === "connected";
        if (connected && !wasConnected) {
          void this.reconcileBackgroundRuns();
        }
      },
    });
    this.unsubscribeBackgroundWatch = () => { unsubscribePush(); unsubscribeConnection(); };
  }

  private releaseBackgroundRun(runId: string, expected?: ActiveAssistantRun) {
    if ((!expected || this.activeRuns.get(runId) === expected) && this.activeRuns.delete(runId)) {
      this.releaseWakeLockIfIdle();
    }
  }

  private async reconcileBackgroundRuns() {
    if (![...this.activeRuns.values()].some((activeRun) => activeRun.background === "running")) {
      return;
    }
    // The token captured at start may have expired during the outage.
    const availability = await this.platform.resolvePlatform();
    if (!availability.ok) {
      return;
    }
    for (const [runId, activeRun] of [...this.activeRuns]) {
      // A Run still awaiting acceptance is settled by its own start transaction.
      if (activeRun.background !== "running") {
        continue;
      }
      try {
        const response = await this.platform.platformFetch(availability.baseUrl, `/api/chat?chatId=${encodeURIComponent(activeRun.chatId)}`, {
          headers: this.platform.jsonHeaders(availability.token)
        });
        if (response.status === 404) {
          this.releaseBackgroundRun(runId, activeRun);
          continue;
        }
        if (!response.ok) {
          continue;
        }
        const body = await response.json() as { data?: { activeRun?: { runId?: string } | null } };
        if (readText(body?.data?.activeRun?.runId) !== runId) {
          this.releaseBackgroundRun(runId, activeRun);
        }
      }
      catch {
        // Unknown stays held; the next reconnect or run.finished Push retries.
      }
    }
  }

  async completeText(request: AssistantStartRunRequest, onRawEvent?: (event: Record<string, unknown>) => boolean | void, strictAttachments = false): Promise<AssistantTextCompletionResult> {
    const message = request.message.trim();
    const chatId = request.chatId?.trim() || createChatId();
    const runId = request.runId?.trim() || createRunId();
    if (!message) {
      return {
        ok: false,
        runId: "",
        chatId,
        text: "",
        message: t("assistant.messageRequired")
      };
    }
    if (this.disposed) {
      return {
        ok: false,
        runId,
        chatId,
        text: "",
        message: "Assistant bridge is disposed"
      };
    }
    const availability = await this.platform.resolvePlatform();
    if (!availability.ok) {
      return {
        ok: false,
        runId,
        chatId,
        text: "",
        message: availability.message
      };
    }
    if (this.activeRuns.has(runId)) {
      return {
        ok: false,
        runId,
        chatId,
        text: "",
        message: "runId is already active"
      };
    }
    const controller = new AbortController();
    const activeRun: ActiveAssistantRun = {
      controller,
      chatId,
      agentKey: request.agentKey?.trim() || "",
      baseUrl: availability.baseUrl,
      token: availability.token,
    };
    this.activeRuns.set(runId, activeRun);
    this.acquireWakeLockForActiveRuns();
    return this.runQuery(availability.baseUrl, availability.token, request, {
      chatId,
      runId,
      activeRun,
      onRawEvent,
      strictAttachments,
    });
  }

  async stopRun(runId: string): Promise<AssistantStopRunResult> {
    const trimmedRunId = runId.trim();
    const activeRun = this.activeRuns.get(trimmedRunId);
    activeRun?.controller.abort();
    if (this.activeRuns.delete(trimmedRunId)) {
      this.releaseWakeLockIfIdle();
    }
    const availability = await this.platform.resolvePlatform();
    if (!availability.ok) {
      return { ok: false, message: availability.message };
    }
    const response = await this.platform.platformFetch(availability.baseUrl, "/api/interrupt", {
      method: "POST",
      headers: this.platform.jsonHeaders(availability.token),
      body: JSON.stringify({
        runId: trimmedRunId,
        ...(activeRun?.agentKey ? { agentKey: activeRun.agentKey } : {}),
        message: "Desktop requested stop."
      })
    });
    if (!response.ok) {
      return { ok: false, message: await readErrorText(response) };
    }
    return { ok: true, message: t("agentPlatform.stopRequested") };
  }

  async submitAwaiting(request: AssistantSubmitAwaitingRequest): Promise<AssistantSubmitAwaitingResult> {
    const runId = request.runId?.trim() || "";
    if (!runId) {
      return { ok: false, message: t("agentPlatform.runIdRequired") };
    }
    const availability = await this.platform.resolvePlatform();
    if (!availability.ok) {
      return { ok: false, message: availability.message };
    }
    const params = request.action === "submit" ? (request.params ?? []) : [{ action: request.action, reason: request.reason || "" }];
    const response = await this.platform.platformFetch(availability.baseUrl, "/api/submit", {
      method: "POST",
      headers: this.platform.jsonHeaders(availability.token),
      body: JSON.stringify({
        runId,
        ...(this.activeRuns.get(runId)?.agentKey ? { agentKey: this.activeRuns.get(runId)?.agentKey } : {}),
        awaitingId: request.awaitingId,
        params
      })
    });
    if (!response.ok) {
      return { ok: false, message: await readErrorText(response) };
    }
    return { ok: true, message: t("agentPlatform.submitted") };
  }

  private async runQuery(baseUrl: string, token: string, request: AssistantStartRunRequest, run: {
    chatId: string;
    runId: string;
    activeRun: ActiveAssistantRun;
    onAcceptance?: (result: AssistantStartRunResult) => void;
    onRawEvent?: (event: Record<string, unknown>) => boolean | void;
    strictAttachments?: boolean;
  }): Promise<AssistantTextCompletionResult> {
    let acceptanceSettled = false;
    let stoppedByRawEvent = false;
    const settleAcceptance = (result: AssistantStartRunResult) => {
      if (acceptanceSettled) {
        return;
      }
      acceptanceSettled = true;
      run.onAcceptance?.(result);
    };
    try {
      const references = await this.attachments.uploadAttachments(baseUrl, token, run.chatId, run.runId, request.attachments ?? [], run.strictAttachments === true);
      const accessLevel = normalizeAssistantAccessLevel(request.accessLevel);
      const requestId = request.requestId?.trim() || run.runId;
      const query: RealtimeQueryHandle = this.realtimeBroker.query({
        baseUrl,
        token,
        id: requestId,
        consumerId: `assistant:${request.source || "copilot"}:${requestId}`,
        runId: run.runId,
        chatId: run.chatId,
        ...(request.agentKey?.trim()
          ? {
            owner: {
              kind: "agent" as const,
              agentKey: request.agentKey.trim()
            }
          }
          : {}),
        signal: run.activeRun.controller.signal,
        payload: {
          requestId,
          runId: run.runId,
          chatId: run.chatId,
          agentKey: request.agentKey?.trim() || undefined,
          message: request.message.trim(),
          ...(request.mustUseSkills?.length ? { mustUseSkills: request.mustUseSkills } : {}),
          ...(accessLevel ? { accessLevel } : {}),
          references,
          params: {
            desktop: {
              source: request.source || "copilot",
              action: request.action || "chat",
              pageContext: request.pageContext ?? null
            }
          },
          scene: request.pageContext
            ? {
              url: request.pageContext.url,
              title: request.pageContext.title
            }
            : undefined,
          stream: true
        },
        onEvent: async (event: Record<string, unknown>, eventPath: string) => {
          const stopAfterEvent = run.onRawEvent?.(event) === true;
          const normalizedEvent = normalizePlatformEvent(event, {
            runId: run.runId,
            chatId: run.chatId,
            source: request.source
          }, eventPath);
          if (!normalizedEvent) {
            throw new Error("time_contract_violation: stream event.type is required");
          }
          const eventText = readAssistantEventOutputText(normalizedEvent);
          const delta = normalizedEvent.type === "content.delta" ? normalizedEvent.delta || eventText : "";
          if (delta) {
            finalMessage += delta;
          }
          if (isAssistantRunTerminalEvent(normalizedEvent)) {
            sawTerminalEvent = true;
            const terminalMessage = normalizedEvent.message ||
              eventText ||
              finalMessage.trim() ||
              (await this.readPersistedFinalAssistantMessage(run.chatId, run.runId));
            if (!finalMessage && terminalMessage) {
              finalMessage = terminalMessage;
            }
            if (!normalizedEvent.message && terminalMessage) {
              normalizedEvent.message = terminalMessage;
            }
          }
          this.options.onEvent(normalizedEvent);
          if (stopAfterEvent && !run.activeRun.controller.signal.aborted) {
            stoppedByRawEvent = true;
            await this.bestEffortInterrupt(run.runId, run.activeRun, "Image Studio reached its single permitted tool boundary.");
            run.activeRun.controller.abort();
          }
        }
      });
      let finalMessage = "";
      let sawTerminalEvent = false;
      const accepted = await query.accepted;
      run.activeRun.agentKey = accepted.owner.kind === "agent" ? accepted.owner.agentKey : run.activeRun.agentKey;
      settleAcceptance({
        ok: true,
        runId: run.runId,
        chatId: run.chatId,
        message: t("agentPlatform.runSubmitted"),
        permissionMode: normalizeAssistantPermissionMode(request.permissionMode),
        fullAccessRemainingMs: 0
      });
      await query.completed;
      if (!sawTerminalEvent) {
        throw new Error("time_contract_violation: stream ended before a timestamped business terminal event");
      }
      return {
        ok: true,
        runId: run.runId,
        chatId: run.chatId,
        text: finalMessage.trim(),
        message: finalMessage.trim()
      };
    }
    catch (error) {
      if (stoppedByRawEvent) {
        return {
          ok: false,
          runId: run.runId,
          chatId: run.chatId,
          text: "",
          message: "Image Studio stopped the agent after its single permitted tool result."
        };
      }
      const message = (error as Error).name === "AbortError"
        ? t("assistant.stopped")
        : error instanceof Error
          ? error.message
          : String(error);
      settleAcceptance({
        ok: false,
        runId: run.runId,
        chatId: run.chatId,
        message
      });
      if (error instanceof Error &&
        (error.name === "connection_lost_before_acceptance" ||
          error.message.startsWith("connection_lost_before_acceptance:")) &&
        run.activeRun.agentKey) {
        this.bestEffortInterrupt(run.runId, run.activeRun, "Desktop Assistant WebSocket disconnected.");
      }
      if ((error as Error).name === "AbortError") {
        if (!this.disposed) {
          this.options.onEvent({
            runId: run.runId,
            chatId: run.chatId,
            type: "stopped",
            createdAt: nowEpochMillis(),
            message
          });
        }
        return {
          ok: false,
          runId: run.runId,
          chatId: run.chatId,
          text: "",
          message
        };
      }
      if (!this.disposed) {
        this.options.onEvent({
          runId: run.runId,
          chatId: run.chatId,
          type: "error",
          ...(isTimeContractViolation(error) ? {} : { createdAt: nowEpochMillis() }),
          message,
          error: message
        });
      }
      return {
        ok: false,
        runId: run.runId,
        chatId: run.chatId,
        text: "",
        message
      };
    }
    finally {
      if (this.activeRuns.get(run.runId) === run.activeRun) {
        this.activeRuns.delete(run.runId);
        this.releaseWakeLockIfIdle();
      }
    }
  }

  dispose() {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const [runId, activeRun] of this.activeRuns) {
      if (activeRun.agentKey) {
        this.bestEffortInterrupt(runId, activeRun, "Desktop Assistant runtime disposed.");
      }
      activeRun.controller.abort();
    }
    this.activeRuns.clear();
    this.unsubscribeBackgroundWatch?.();
    this.unsubscribeBackgroundWatch = null;
    if (this.ownsRealtimeBroker) {
      this.realtimeBroker.dispose();
    }
    this.releaseWakeLockIfIdle();
  }

  private bestEffortInterrupt(runId: string, activeRun: ActiveAssistantRun, message: string) {
    return this.platform.platformFetch(activeRun.baseUrl, "/api/interrupt", {
      method: "POST",
      headers: this.platform.jsonHeaders(activeRun.token),
      body: JSON.stringify({ runId, agentKey: activeRun.agentKey, message })
    }).then(() => undefined).catch(() => undefined);
  }

  private async readPersistedFinalAssistantMessage(chatId: string, runId: string): Promise<string> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const text = readFinalAssistantTextFromChatFile(this.options.resolveChatFile(chatId), runId);
      if (text || attempt === 3) {
        return text;
      }
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    return "";
  }
}
