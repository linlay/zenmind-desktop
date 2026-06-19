import type { App } from "electron";
import type { AgentAuthIssueResult, ServiceId, ServiceState } from "../../../shared/contracts";
import { DesktopPetSseParser, type DesktopPetPreviewEvent } from "./desktop-pet-preview";

const AGENT_PLATFORM_SERVICE_ID: ServiceId = "agent-platform";
const ATTACH_RECONNECT_MS = 800;

function createApiUrl(baseUrl: string, pathname: string) {
  const url = new URL(pathname, baseUrl);
  return url.toString();
}

function readErrorCode(value: unknown) {
  if (typeof value !== "object" || value === null) {
    return "";
  }
  const record = value as Record<string, unknown>;
  return typeof record.code === "string" ? record.code : "";
}

async function readErrorText(response: Response) {
  try {
    const text = await response.text();
    if (!text.trim()) {
      return `HTTP ${response.status}`;
    }
    try {
      const payload = JSON.parse(text) as Record<string, unknown>;
      const code = readErrorCode(payload);
      const message = typeof payload.msg === "string"
        ? payload.msg
        : typeof payload.message === "string"
          ? payload.message
          : text;
      return code ? `${code}: ${message}` : message;
    } catch {
      return text;
    }
  } catch {
    return `HTTP ${response.status}`;
  }
}

export class AgentPlatformPetStreamClient {
  private active: {
    runId: string;
    chatId: string | null;
    lastSeq: number;
    controller: AbortController;
    reconnectTimer: ReturnType<typeof setTimeout> | null;
    done: boolean;
  } | null = null;

  constructor(private readonly options: {
    app: App;
    getServiceState: (app: App, serviceId: ServiceId) => Promise<ServiceState>;
    issueAccessToken: (app: App, reason: "missing" | "unauthorized") => Promise<AgentAuthIssueResult>;
    onEvent: (event: DesktopPetPreviewEvent) => void;
    onDebug?: (message: string) => void;
  }) {}

  attach(runId: string, chatId?: string | null) {
    const trimmedRunId = runId.trim();
    if (!trimmedRunId) {
      return;
    }
    if (this.active?.runId === trimmedRunId && !this.active.done) {
      return;
    }
    this.stop();
    this.active = {
      runId: trimmedRunId,
      chatId: chatId || null,
      lastSeq: 0,
      controller: new AbortController(),
      reconnectTimer: null,
      done: false
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
    if (active.reconnectTimer) {
      clearTimeout(active.reconnectTimer);
    }
    active.controller.abort();
  }

  private scheduleReconnect(runId: string) {
    const active = this.active;
    if (!active || active.runId !== runId || active.done || active.reconnectTimer) {
      return;
    }
    active.reconnectTimer = setTimeout(() => {
      if (!this.active || this.active.runId !== runId) {
        return;
      }
      this.active.reconnectTimer = null;
      void this.attachOnce(runId);
    }, ATTACH_RECONNECT_MS);
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
      if (!tokenResult.ok || !tokenResult.token.trim()) {
        this.options.onDebug?.(tokenResult.message || "agent-platform token unavailable");
        return;
      }

      const url = new URL(createApiUrl(baseUrl, "/api/attach"));
      url.searchParams.set("runId", runId);
      url.searchParams.set("lastSeq", String(active.lastSeq));
      const response = await fetch(url.toString(), {
        headers: {
          Accept: "text/event-stream",
          Authorization: `Bearer ${tokenResult.token.trim()}`
        },
        signal: active.controller.signal
      });

      if (!response.ok) {
        const errorText = await readErrorText(response);
        this.options.onDebug?.(`agent-platform attach failed: ${errorText}`);
        if (!errorText.includes("SEQ_EXPIRED")) {
          this.scheduleReconnect(runId);
        }
        return;
      }
      await this.consumeResponse(runId, response);
    } catch (error) {
      if ((error as Error).name === "AbortError") {
        return;
      }
      this.options.onDebug?.(error instanceof Error ? error.message : String(error));
      this.scheduleReconnect(runId);
    }
  }

  private async consumeResponse(runId: string, response: Response) {
    const active = this.active;
    if (!active || active.runId !== runId || !response.body) {
      return;
    }

    const parser = new DesktopPetSseParser();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let sawDone = false;

    try {
      while (true) {
        const { done, value } = await reader.read();
        const chunk = decoder.decode(value || new Uint8Array(), { stream: !done });
        const result = done ? parser.finish() : parser.push(chunk);
        for (const error of result.errors) {
          this.options.onDebug?.(`[desktop-pet attach sse] ${error}`);
        }
        for (const event of result.events) {
          if (!this.active || this.active.runId !== runId) {
            return;
          }
          if (event.seq && event.seq > this.active.lastSeq) {
            this.active.lastSeq = event.seq;
          }
          this.options.onEvent(event);
        }
        if (result.done) {
          sawDone = true;
        }
        if (done) {
          break;
        }
      }
    } finally {
      reader.releaseLock();
    }

    if (!this.active || this.active.runId !== runId) {
      return;
    }
    if (sawDone) {
      this.active.done = true;
      return;
    }
    this.scheduleReconnect(runId);
  }
}
