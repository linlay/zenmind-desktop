import type { App } from "electron";
import type { AgentAuthIssueResult, ServiceId, ServiceState } from "../../../shared/contracts";
import type { DesktopPetPreviewEvent } from "./desktop-pet-preview";
import { RealtimeBroker } from "../../realtime/realtime-broker";

const AGENT_PLATFORM_SERVICE_ID: ServiceId = "agent-platform";

export class AgentPlatformPetStreamClient {
  private readonly realtimeBroker: RealtimeBroker;
  private readonly ownsRealtimeBroker: boolean;
  private active: {
    runId: string;
    chatId: string;
    lastSeq: number;
    unsubscribe: (() => void) | null;
    done: boolean;
  } | null = null;

  constructor(private readonly options: {
    app: App;
    getServiceState: (app: App, serviceId: ServiceId) => Promise<ServiceState>;
    issueAccessToken: (app: App, reason: "missing" | "unauthorized") => Promise<AgentAuthIssueResult>;
    realtimeBroker?: RealtimeBroker;
    onEvent: (event: DesktopPetPreviewEvent) => void;
    onDebug?: (message: string) => void;
  }) {
    this.ownsRealtimeBroker = !options.realtimeBroker;
    this.realtimeBroker = options.realtimeBroker ?? new RealtimeBroker({
      app: options.app,
      issueAccessToken: options.issueAccessToken,
      onDiagnostic: options.onDebug,
    });
  }

  attach(runId: string, chatId?: string | null) {
    const trimmedRunId = runId.trim();
    const trimmedChatId = chatId?.trim() || "";
    if (!trimmedRunId) {
      return;
    }
    if (!trimmedChatId) {
      this.options.onDebug?.("agent-platform realtime attach requires the source chatId");
      return;
    }
    if (this.active?.runId === trimmedRunId && !this.active.done) {
      return;
    }
    this.stop();
    this.active = {
      runId: trimmedRunId,
      chatId: trimmedChatId,
      lastSeq: 0,
      unsubscribe: null,
      done: false,
    };
    void this.attachOnce(trimmedRunId);
  }

  stop() {
    const active = this.active;
    this.active = null;
    if (!active) {
      return;
    }
    active.done = true;
    active.unsubscribe?.();
    this.realtimeBroker.cleanupConsumer(`desktop-pet-stream:${active.runId}`);
    if (this.ownsRealtimeBroker) {
      this.realtimeBroker.rotateIdentity();
    }
  }

  private async attachOnce(runId: string) {
    const active = this.active;
    if (!active || active.runId !== runId || active.done) {
      return;
    }
    try {
      const serviceState = await this.options.getServiceState(this.options.app, AGENT_PLATFORM_SERVICE_ID);
      const baseUrl = serviceState.status === "running" ? serviceState.healthMeta.webUrl.trim() : "";
      if (!baseUrl) {
        this.options.onDebug?.("agent-platform is not running");
        return;
      }
      const tokenResult = await this.options.issueAccessToken(this.options.app, "missing");
      const token = tokenResult.ok ? tokenResult.token.trim() : "";
      if (!token) {
        this.options.onDebug?.(tokenResult.message || "agent-platform token unavailable");
        return;
      }
      const subscription = this.realtimeBroker.subscribeRun({
        baseUrl,
        token,
        runId,
        chatId: active.chatId,
        lastSeq: active.lastSeq,
        kind: "internal",
        consumerId: `desktop-pet-stream:${runId}`,
        onEvent: (event) => {
          const current = this.active;
          if (!current || current.runId !== runId || current.done) {
            return;
          }
          if (typeof event.seq === "number" && event.seq > current.lastSeq) {
            current.lastSeq = event.seq;
          }
          this.options.onEvent(event as DesktopPetPreviewEvent);
        },
        onComplete: () => {
          if (this.active?.runId === runId) {
            this.active.done = true;
            this.active.unsubscribe?.();
            this.active.unsubscribe = null;
          }
        },
        onError: (error) => this.options.onDebug?.(error.message),
      });
      if (this.active?.runId === runId) {
        this.active.unsubscribe = subscription.unsubscribe;
      } else {
        subscription.unsubscribe();
      }
    } catch (error) {
      this.options.onDebug?.(error instanceof Error ? error.message : String(error));
    }
  }
}
