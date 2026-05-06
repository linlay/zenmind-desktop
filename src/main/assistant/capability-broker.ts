export type AssistantPermissionMode = "safe_default" | "enhanced" | "operator" | "default" | "full_access";

export type AssistantCapabilityKind =
  | "browser"
  | "host_app"
  | "sandbox_command"
  | "host_command"
  | "host_startup"
  | "service"
  | "file_operation"
  | "operator_mode"
  | "artifact"
  | "planning"
  | "awaiting"
  | "unknown";

export type AssistantCapabilityRiskLevel = "low" | "medium" | "high" | "critical";

export type AssistantToolRouteInput = {
  toolName: string;
  args?: Record<string, unknown>;
  platform?: NodeJS.Platform | string;
  permissionMode?: AssistantPermissionMode;
  operatorActive?: boolean;
};

export type AssistantToolRouteDecision = {
  kind: AssistantCapabilityKind;
  operation: string;
  routedToolName: string;
  args: Record<string, unknown>;
  requiresApproval: boolean;
  requiresSandbox: boolean;
  riskLevel: AssistantCapabilityRiskLevel;
  denied: boolean;
  message: string;
};

export type OperatorModeGrant = {
  chatId: string;
  grantedAt: number;
  expiresAt: number;
  durationMs: number;
};

type HostAppDefinition = {
  id: string;
  displayName: string;
  aliases: string[];
  commands: Partial<Record<string, string>>;
};

const OPERATOR_MODE_MAX_DURATION_MS = 15 * 60 * 1000;
const OPERATOR_MODE_DEFAULT_DURATION_MS = 5 * 60 * 1000;

const HOST_APP_ALLOWLIST: HostAppDefinition[] = [
  {
    id: "docker-desktop",
    displayName: "Docker Desktop",
    aliases: ["docker", "docerk", "docker desktop", "docker.app"],
    commands: {
      darwin: "open -a \"Docker Desktop\"",
      win32: "Start-Process \"Docker Desktop\""
    }
  },
  {
    id: "terminal",
    displayName: "Terminal",
    aliases: ["terminal", "终端", "mac terminal"],
    commands: {
      darwin: "open -a \"Terminal\""
    }
  },
  {
    id: "windows-terminal",
    displayName: "Windows Terminal",
    aliases: ["windows terminal", "terminal", "wt", "终端"],
    commands: {
      win32: "Start-Process \"wt\""
    }
  },
  {
    id: "claude-code",
    displayName: "Claude Code",
    aliases: ["claude", "claude code", "claude-code", "claude desktop", "anthropic claude"],
    commands: {
      darwin: "open -a \"Claude\"",
      win32: "Start-Process \"Claude\""
    }
  },
  {
    id: "chrome",
    displayName: "Google Chrome",
    aliases: ["chrome", "google chrome", "谷歌浏览器"],
    commands: {
      darwin: "open -a \"Google Chrome\"",
      win32: "Start-Process \"chrome\""
    }
  },
  {
    id: "edge",
    displayName: "Microsoft Edge",
    aliases: ["edge", "microsoft edge", "msedge"],
    commands: {
      darwin: "open -a \"Microsoft Edge\"",
      win32: "Start-Process \"msedge\""
    }
  }
];

function normalizedText(value: unknown) {
  return String(value ?? "")
    .trim()
    .replace(/\s+/gu, " ")
    .toLowerCase();
}

function currentPlatform(platform: AssistantToolRouteInput["platform"]) {
  return String(platform || process.platform);
}

function route(
  input: Partial<AssistantToolRouteDecision> & Pick<AssistantToolRouteDecision, "kind" | "operation" | "routedToolName">
): AssistantToolRouteDecision {
  return {
    args: {},
    requiresApproval: false,
    requiresSandbox: false,
    riskLevel: "low",
    denied: false,
    message: "",
    ...input
  };
}

function deniedRoute(message: string, args: Record<string, unknown> = {}): AssistantToolRouteDecision {
  return route({
    kind: "unknown",
    operation: "deny",
    routedToolName: "capability_denied",
    args,
    denied: true,
    requiresApproval: false,
    requiresSandbox: false,
    riskLevel: "high",
    message
  });
}

function findHostAppByName(name: unknown, platform: string) {
  const normalized = normalizedText(name);
  if (!normalized) {
    return null;
  }
  return HOST_APP_ALLOWLIST.find((app) => (
    app.commands[platform] &&
    (normalized === app.id || normalized === normalizedText(app.displayName) || app.aliases.some((alias) => normalized === normalizedText(alias)))
  )) ?? null;
}

function extractMacOpenAppName(command: string) {
  const match = command.match(/^open\s+(?:-[A-Za-z]\s+)*(?:"([^"]+)"|'([^']+)'|([^\s].*?))\s*$/iu);
  if (!match) {
    return "";
  }
  const candidate = (match[1] || match[2] || match[3] || "").trim();
  const appMatch = candidate.match(/^-a\s+(?:"([^"]+)"|'([^']+)'|(.+))$/iu);
  return (appMatch?.[1] || appMatch?.[2] || appMatch?.[3] || candidate).trim();
}

function extractWindowsStartAppName(command: string) {
  const startProcess = command.match(/(?:^|\b)Start-Process\s+(?:"([^"]+)"|'([^']+)'|([^\s].*?))\s*$/iu);
  if (startProcess) {
    return (startProcess[1] || startProcess[2] || startProcess[3] || "").trim();
  }
  const start = command.match(/^(?:start|cmd(?:\.exe)?\s+\/c\s+start)\s+(?:"[^"]*"\s+)?(?:"([^"]+)"|'([^']+)'|([^\s].*?))\s*$/iu);
  return (start?.[1] || start?.[2] || start?.[3] || "").trim();
}

function findHostAppFromCommand(command: unknown, platform: string) {
  const text = String(command ?? "").trim();
  if (!text) {
    return null;
  }
  if (platform === "darwin") {
    return findHostAppByName(extractMacOpenAppName(text), platform);
  }
  if (platform === "win32") {
    return findHostAppByName(extractWindowsStartAppName(text), platform);
  }
  return null;
}

function hostAppRoute(
  app: HostAppDefinition,
  platform: string,
  originalArgs: Record<string, unknown>,
  permissionMode: AssistantPermissionMode = "safe_default",
  operatorActive?: boolean
) {
  return route({
    kind: "host_app",
    operation: "launch",
    routedToolName: "host_app_launch",
    args: {
      ...originalArgs,
      appId: app.id,
      appName: app.displayName,
      command: app.commands[platform] || ""
    },
    requiresApproval: !hasTrustedHostControl(permissionMode, operatorActive),
    requiresSandbox: false,
    riskLevel: "medium",
    message: `准备启动白名单本机应用：${app.displayName}`
  });
}

function hasTrustedHostControl(permissionMode: AssistantPermissionMode, operatorActive?: boolean) {
  return permissionMode === "full_access" || (permissionMode === "operator" && operatorActive);
}

export function routeAssistantToolRequest(input: AssistantToolRouteInput): AssistantToolRouteDecision {
  const toolName = String(input.toolName || "").trim();
  const args = input.args ?? {};
  const platform = currentPlatform(input.platform);
  const permissionMode = input.permissionMode ?? "safe_default";

  if (toolName.startsWith("browser_")) {
    return route({
      kind: "browser",
      operation: toolName.replace(/^browser_/u, ""),
      routedToolName: toolName,
      args,
      requiresSandbox: false,
      riskLevel: toolName === "browser_submit" || toolName === "browser_cdp_command" ? "medium" : "low"
    });
  }

  if (toolName === "host_app_launch") {
    const app = findHostAppByName(args.app || args.appName || args.app_name || args.app_name_or_path || args.target || args.name || args.path, platform)
      ?? findHostAppFromCommand(args.command, platform);
    return app
      ? hostAppRoute(app, platform, args, permissionMode, input.operatorActive)
      : deniedRoute("本机应用不在侧边栏助手白名单内，已拒绝启动。", args);
  }

  if (toolName === "host_startup_list" || toolName === "host_startup_remove") {
    const destructive = toolName === "host_startup_remove";
    return route({
      kind: "host_startup",
      operation: toolName === "host_startup_list" ? "list" : "remove",
      routedToolName: toolName,
      args,
      requiresApproval: destructive && !hasTrustedHostControl(permissionMode, input.operatorActive),
      requiresSandbox: false,
      riskLevel: destructive ? "high" : "low",
      message: destructive
        ? "准备修改本机开机启动项，执行前需要确认。"
        : "准备读取本机开机启动项。"
    });
  }

  if (toolName === "service_list" || toolName === "service_control") {
    return route({
      kind: "service",
      operation: toolName === "service_list" ? "list" : "control",
      routedToolName: toolName,
      args,
      requiresApproval: false,
      requiresSandbox: false,
      riskLevel: toolName === "service_control" ? "medium" : "low",
      message: toolName === "service_control" ? "准备控制并复查 Desktop 托管服务。" : "准备读取 Desktop 托管服务状态。"
    });
  }

  if (toolName === "bash" || toolName === "bash_sandbox") {
    const hostApp = findHostAppFromCommand(args.command, platform);
    if (hostApp) {
      return hostAppRoute(hostApp, platform, args, permissionMode, input.operatorActive);
    }
    return route({
      kind: "host_command",
      operation: "execute",
      routedToolName: "bash",
      args,
      requiresApproval: !hasTrustedHostControl(permissionMode, input.operatorActive),
      requiresSandbox: false,
      riskLevel: "medium",
      message: hasTrustedHostControl(permissionMode, input.operatorActive)
        ? "完全允许控制已开启，准备直接执行宿主机命令。"
        : "询问后操作模式下，宿主机命令需要用户确认。"
    });
  }

  if (toolName.startsWith("desktop_")) {
    const rawOperation = toolName.replace(/^desktop_/u, "");
    const operation = rawOperation === "delete_files" ? "delete" : rawOperation;
    const createsFile = rawOperation.startsWith("create_");
    const destructive = createsFile || rawOperation === "write_file" || rawOperation === "move_files" || rawOperation === "delete_files";
    return route({
      kind: "file_operation",
      operation,
      routedToolName: toolName,
      args,
      requiresApproval: destructive && !hasTrustedHostControl(permissionMode, input.operatorActive),
      requiresSandbox: false,
      riskLevel: rawOperation === "delete_files" || rawOperation === "move_files" ? "high" : destructive ? "medium" : "low"
    });
  }

  if (toolName === "_ask_user_question_" || toolName === "ask_user_question" || toolName === "AskUserQuestion") {
    return route({
      kind: "awaiting",
      operation: "question",
      routedToolName: toolName,
      args,
      requiresApproval: false,
      requiresSandbox: false,
      riskLevel: "low"
    });
  }

  if (toolName === "operator_mode_request" || toolName === "operator_mode_revoke") {
    return route({
      kind: "operator_mode",
      operation: toolName === "operator_mode_request" ? "request" : "revoke",
      routedToolName: toolName,
      args,
      requiresApproval: toolName === "operator_mode_request",
      requiresSandbox: false,
      riskLevel: toolName === "operator_mode_request" ? "critical" : "medium"
    });
  }

  if (toolName === "artifact_publish") {
    return route({ kind: "artifact", operation: "publish", routedToolName: toolName, args });
  }

  if (toolName === "plan_add_tasks" || toolName === "plan_update_task") {
    return route({ kind: "planning", operation: toolName.replace(/^plan_/u, ""), routedToolName: toolName, args });
  }

  return deniedRoute(`未知或未登记的侧边栏助手能力：${toolName}`, args);
}

export function createOperatorModeGrant({
  chatId,
  requestedMinutes,
  now = Date.now()
}: {
  chatId: string;
  requestedMinutes?: number;
  now?: number;
}): OperatorModeGrant {
  const requestedMs = Number.isFinite(requestedMinutes)
    ? Math.max(1, Number(requestedMinutes)) * 60 * 1000
    : OPERATOR_MODE_DEFAULT_DURATION_MS;
  const durationMs = Math.min(requestedMs, OPERATOR_MODE_MAX_DURATION_MS);
  return {
    chatId,
    grantedAt: now,
    expiresAt: now + durationMs,
    durationMs
  };
}

export const __testInternals = {
  HOST_APP_ALLOWLIST,
  OPERATOR_MODE_MAX_DURATION_MS,
  createOperatorModeGrant,
  extractMacOpenAppName,
  extractWindowsStartAppName,
  findHostAppByName,
  findHostAppFromCommand
};
