import type { App } from "electron";
import { t } from "../../support/i18n/main-i18n";

export type ContainerHubConfig = {
  baseURL: string;
  authToken?: string;
  timeoutMs?: number;
  defaultEnvironmentName?: string;
};

export type ContainerHubSession = {
  sessionId: string;
  environmentName: string;
  cwd: string;
};

export type ContainerHubExecuteResult = {
  ok: boolean;
  sessionId: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  workingDirectory: string;
  timedOut?: boolean;
};

export type ContainerHubMount = {
  source: string;
  destination: string;
  read_only?: boolean;
};

export type ContainerHubBuildJob = {
  id: string;
  environmentName: string;
  imageRef: string;
  target: string;
  status: string;
};

export type ContainerHubEnvironment = {
  name: string;
  description: string;
  imageRepository: string;
  imageTag: string;
  imageRef: string;
  available: boolean;
  enabled: boolean;
  availableBuildTargets: string[];
  lastBuild?: ContainerHubBuildJob;
};

export type ContainerHubEnvironmentUpsertInput = Record<string, unknown> & {
  name: string;
};

export class ContainerHubClient {
  private readonly baseURL: string;
  private readonly authToken: string;
  private readonly timeoutMs: number;

  constructor(config: ContainerHubConfig) {
    this.baseURL = config.baseURL.trim().replace(/\/+$/u, "");
    this.authToken = config.authToken?.trim() ?? "";
    this.timeoutMs = Math.max(config.timeoutMs ?? 30000, 1000);
  }

  async getRuntimeInfo() {
    const result = await this.requestJSON("GET", "/api/runtime-info");
    return {
      ok: true,
      engine: typeof result.engine === "string" ? result.engine : ""
    };
  }

  async listEnvironments(): Promise<ContainerHubEnvironment[]> {
    const result = await this.requestJSONValue("GET", "/api/environments");
    if (!Array.isArray(result)) {
      return [];
    }
    return result
      .map(normalizeEnvironment)
      .filter((environment): environment is ContainerHubEnvironment => Boolean(environment));
  }

  async startBuildJob(environmentName: string, target = ""): Promise<ContainerHubBuildJob> {
    const result = await this.requestJSON(
      "POST",
      `/api/environments/${encodeURIComponent(environmentName)}/build-jobs`,
      target ? { target } : {}
    );
    return normalizeBuildJob(result) ?? {
      id: "",
      environmentName,
      imageRef: "",
      target,
      status: ""
    };
  }

  async upsertEnvironment(input: ContainerHubEnvironmentUpsertInput): Promise<ContainerHubEnvironment> {
    const result = await this.requestJSON("POST", "/api/environments", input);
    return normalizeEnvironment(result) ?? {
      name: input.name,
      description: "",
      imageRepository: "",
      imageTag: "",
      imageRef: "",
      available: false,
      enabled: false,
      availableBuildTargets: []
    };
  }

  async putEnvironmentFile(environmentName: string, relativePath: string, content: string) {
    return this.requestJSON(
      "PUT",
      `/api/environments/${encodeURIComponent(environmentName)}/files/${encodeURI(relativePath).replace(/#/gu, "%23")}`,
      { content }
    );
  }

  async createSession(input: {
    sessionId: string;
    environmentName: string;
    cwd?: string;
    mounts: ContainerHubMount[];
    labels?: Record<string, string>;
  }): Promise<ContainerHubSession> {
    const result = await this.requestJSON("POST", "/api/sessions/create", {
      session_id: input.sessionId,
      environment_name: input.environmentName,
      cwd: input.cwd || "/workspace",
      mounts: input.mounts,
      labels: input.labels ?? {}
    });
    return {
      sessionId: stringValue(result.session_id) || input.sessionId,
      environmentName: stringValue(result.environment_name) || input.environmentName,
      cwd: stringValue(result.cwd) || input.cwd || "/workspace"
    };
  }

  async executeSession(input: {
    sessionId: string;
    command: string;
    cwd?: string;
    timeoutMs?: number;
  }): Promise<ContainerHubExecuteResult> {
    const response = await this.requestRaw("POST", `/api/sessions/${encodeURIComponent(input.sessionId)}/execute`, {
      command: "/bin/sh",
      args: ["-lc", input.command],
      cwd: input.cwd || "/workspace",
      timeout_ms: input.timeoutMs ?? this.timeoutMs
    });
    const contentType = response.contentType.toLowerCase();
    if (!contentType.startsWith("application/json")) {
      return {
        ok: true,
        sessionId: input.sessionId,
        exitCode: 0,
        stdout: response.body,
        stderr: "",
        workingDirectory: input.cwd || "/workspace"
      };
    }
    const decoded = parseJSONRecord(response.body);
    const exitCode = numberValue(decoded.exit_code, numberValue(decoded.exitCode, -1));
    return {
      ok: exitCode === 0,
      sessionId: input.sessionId,
      exitCode,
      stdout: stringValue(decoded.stdout),
      stderr: stringValue(decoded.stderr),
      workingDirectory: stringValue(decoded.working_directory) || input.cwd || "/workspace",
      timedOut: Boolean(decoded.timed_out)
    };
  }

  async stopSession(sessionId: string) {
    return this.requestJSON("POST", `/api/sessions/${encodeURIComponent(sessionId)}/stop`, {});
  }

  private async requestJSON(method: string, apiPath: string, body?: unknown) {
    const value = await this.requestJSONValue(method, apiPath, body);
    return asRecord(value);
  }

  private async requestJSONValue(method: string, apiPath: string, body?: unknown) {
    const response = await this.requestRaw(method, apiPath, body);
    if (!response.body.trim()) {
      return {};
    }
    return JSON.parse(response.body) as unknown;
  }

  private async requestRaw(method: string, apiPath: string, body?: unknown) {
    if (!this.baseURL) {
      throw new Error(t("containerHub.baseUrlMissing"));
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseURL}${apiPath}`, {
        method,
        headers: {
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...(this.authToken ? { authorization: `Bearer ${this.authToken}` } : {})
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(readContainerHubError(apiPath, response.status, text));
      }
      return {
        body: text,
        contentType: response.headers.get("content-type") ?? ""
      };
    } catch (error) {
      if ((error as Error).name === "AbortError") {
        throw new Error(t("containerHub.requestTimeout", { path: apiPath }));
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

export function getAssistantWorkspacePath(_app: App, _chatId: string) {
  return "/workspace";
}

export function buildContainerHubRunSessionId(runId: string) {
  const normalized = runId.toLowerCase().replace(/[^a-z0-9_.-]+/gu, "-").replace(/^-+|-+$/gu, "");
  return `run-${normalized || Date.now().toString(36)}`.slice(0, 120);
}

function parseJSONRecord(text: string): Record<string, unknown> {
  if (!text.trim()) {
    return {};
  }
  const parsed = JSON.parse(text) as unknown;
  return asRecord(parsed);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringArrayValue(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function normalizeBuildJob(value: unknown): ContainerHubBuildJob | undefined {
  const raw = asRecord(value);
  const id = stringValue(raw.id);
  const environmentName = stringValue(raw.environment_name);
  if (!id && !environmentName) {
    return undefined;
  }
  return {
    id,
    environmentName,
    imageRef: stringValue(raw.image_ref),
    target: stringValue(raw.target),
    status: stringValue(raw.status)
  };
}

function normalizeEnvironment(value: unknown): ContainerHubEnvironment | undefined {
  const raw = asRecord(value);
  const name = stringValue(raw.name);
  if (!name) {
    return undefined;
  }
  return {
    name,
    description: stringValue(raw.description),
    imageRepository: stringValue(raw.image_repository),
    imageTag: stringValue(raw.image_tag),
    imageRef: stringValue(raw.image_ref),
    available: Boolean(raw.available),
    enabled: Boolean(raw.enabled),
    availableBuildTargets: stringArrayValue(raw.available_build_targets),
    lastBuild: normalizeBuildJob(raw.last_build)
  };
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown, fallback: number) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

function readContainerHubError(apiPath: string, status: number, body: string) {
  const trimmed = body.trim();
  if (!trimmed) {
    return t("containerHub.httpError", { path: apiPath, status });
  }
  try {
    const parsed = parseJSONRecord(trimmed);
    const message = stringValue(parsed.error) || stringValue(parsed.message) || stringValue(parsed.detail);
    if (message) {
      return t("containerHub.httpErrorWithMessage", { path: apiPath, status, message });
    }
  } catch {
    // Fall through to compact plain text below.
  }
  return t("containerHub.httpErrorWithMessage", { path: apiPath, status, message: trimmed.slice(0, 1000) });
}

export const __testInternals = {
  parseJSONRecord,
  readContainerHubError,
  stringValue
};
