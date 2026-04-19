export type HostThemeMode = "light" | "dark";
export type HostAccessTokenReason = "missing" | "unauthorized";
export type HostCodeAssistantAccessMode = "global" | "folder";

export interface HostCodeAssistantRuntimeStatus {
  agentKey: string;
  ready: boolean;
  recovering?: boolean;
  message?: string;
  onRestartRuntime?: () => Promise<{ ok?: boolean; message?: string } | void> | void;
}

export interface HostCodeAssistantAccessControl {
  agentKey: string;
  mode: HostCodeAssistantAccessMode;
  pending?: boolean;
  title?: string;
  globalLabel?: string;
  folderLabel?: string;
  onSelectMode: (mode: HostCodeAssistantAccessMode) => Promise<void> | void;
}

export interface HostCodeAssistantRepoControl {
  agentKey: string;
  repoPath: string;
  repoLabel: string;
  repoExists: boolean;
  userSelected: boolean;
  currentBranch: string;
  branches: string[];
  pending?: boolean;
  onSelectRepo: () => Promise<void> | void;
  onSelectBranch: (branch: string) => Promise<void> | void;
}

export interface AgentWebClientHost {
  mode: "desktop-native";
  serviceBaseUrl: string;
  themeMode: HostThemeMode;
  requestAccessToken: (reason: HostAccessTokenReason) => Promise<string | null>;
  nativeRootElement?: HTMLElement | null;
  codeAssistantRuntime?: HostCodeAssistantRuntimeStatus | null;
  codeAssistantAccess?: HostCodeAssistantAccessControl | null;
  codeAssistantRepo?: HostCodeAssistantRepoControl | null;
}

let currentHost: AgentWebClientHost | null = null;

function trimTrailingSlash(value: string): string {
  return String(value || "").trim().replace(/\/+$/u, "");
}

export function setAgentWebClientHost(host: AgentWebClientHost | null): void {
  currentHost = host
    ? {
        ...host,
        serviceBaseUrl: trimTrailingSlash(host.serviceBaseUrl)
      }
    : null;

  if (typeof window !== "undefined") {
    window.__ZENMIND_AGENT_HOST = currentHost ?? undefined;
  }
}

export function getAgentWebClientHost(): AgentWebClientHost | null {
  if (currentHost) {
    return currentHost;
  }
  if (typeof window !== "undefined" && window.__ZENMIND_AGENT_HOST) {
    return window.__ZENMIND_AGENT_HOST;
  }
  return null;
}

export function hasNativeAgentWebClientHost(): boolean {
  return getAgentWebClientHost()?.mode === "desktop-native";
}

export function isLegacyEmbeddedDesktopMode(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  try {
    return new URLSearchParams(window.location.search).get("desktopApp") === "1";
  } catch {
    return false;
  }
}

export function isDesktopManagedMode(): boolean {
  return hasNativeAgentWebClientHost() || isLegacyEmbeddedDesktopMode();
}

export function resolveHostThemeMode(): HostThemeMode | null {
  return getAgentWebClientHost()?.themeMode ?? null;
}

export function resolveHostRootElement(): HTMLElement | null {
  return getAgentWebClientHost()?.nativeRootElement ?? null;
}

export function resolveHostPopupContainer(fallback?: HTMLElement | null): HTMLElement | null {
  return resolveHostRootElement() ?? fallback ?? (typeof document !== "undefined" ? document.body : null);
}

export async function requestHostAccessToken(reason: HostAccessTokenReason): Promise<string | null> {
  const host = getAgentWebClientHost();
  if (!host) {
    return null;
  }

  const token = await host.requestAccessToken(reason);
  return typeof token === "string" && token.trim() ? token.trim() : null;
}

export function resolveAssistantHttpUrl(rawPath: string): string {
  const pathValue = String(rawPath || "").trim();
  if (!pathValue) {
    return pathValue;
  }

  try {
    return new URL(pathValue).toString();
  } catch {
    // Keep resolving against the host base URL below.
  }

  const host = getAgentWebClientHost();
  if (!host?.serviceBaseUrl) {
    return pathValue;
  }

  return new URL(pathValue, `${host.serviceBaseUrl}/`).toString();
}

export function resolveAssistantWsUrl(
  rawPath: string,
  options: {
    token?: string;
    tokenParam?: string;
  } = {}
): string {
  const resolvedHttpUrl = resolveAssistantHttpUrl(rawPath);
  const url = (() => {
    try {
      return new URL(resolvedHttpUrl);
    } catch {
      if (typeof window !== "undefined") {
        return new URL(rawPath, `${window.location.protocol}//${window.location.host}`);
      }
      return new URL(rawPath, "http://127.0.0.1");
    }
  })();
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";

  const token = String(options.token || "").trim();
  const tokenParam = String(options.tokenParam || "").trim();
  if (token && tokenParam) {
    url.searchParams.set(tokenParam, token);
  }

  return url.toString();
}

export function resolveHostCodeAssistantAccess(): HostCodeAssistantAccessControl | null {
  return getAgentWebClientHost()?.codeAssistantAccess ?? null;
}

export function resolveHostCodeAssistantRepo(): HostCodeAssistantRepoControl | null {
  return getAgentWebClientHost()?.codeAssistantRepo ?? null;
}

export function resolveHostCodeAssistantRuntime(): HostCodeAssistantRuntimeStatus | null {
  return getAgentWebClientHost()?.codeAssistantRuntime ?? null;
}
