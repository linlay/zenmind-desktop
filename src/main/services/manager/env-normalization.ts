import path from "node:path";
import type { App } from "electron";
import type { ServiceDefinition } from "../../manifest-utils";
import { readEnvFile } from "../../env-file";
import {
  resolveConfigPath,
  type ServiceLayout
} from "./layout";
import {
  upsertEnvFileContent,
  writeEnvFileUpdates
} from "./env-content";
import {
  agentPlatformDesktopRuntimePaths,
  normalizeConfigPath,
  resolveDesktopDir
} from "./runtime-paths";
import {
  isCommandBasenameMatch,
  resolveCommandBin
} from "./command-env";
import { IS_WINDOWS } from "./command-runner";

const DEFAULT_LOCAL_CLI_ACP_RELAY_PORT = "3220";
export const LOCAL_CLI_ACP_RELAY_PLUGIN_ID = "local-cli-acp-relay";
const DEFAULT_CLAUDE_CODE_ACP_ARGS = "-y @zed-industries/claude-code-acp";
const DEFAULT_LOCAL_CLI_ACP_HANDSHAKE_TIMEOUT_MS = "60000";
const DEFAULT_LOCAL_CLI_ACP_RUN_TIMEOUT_MS = "600000";
const AGENT_BASH_SHELL_EXECUTABLE_KEY = "AGENT_BASH_SHELL_EXECUTABLE";
const AGENT_BASH_SHELL_ARGS_KEY = "AGENT_BASH_SHELL_ARGS";
const WINDOWS_AGENT_BASH_SHELL_EXECUTABLE = "powershell.exe";
const WINDOWS_AGENT_BASH_SHELL_ARGS = "-NoProfile,-ExecutionPolicy,Bypass,-Command,{{command}}";
const AGENT_PLATFORM_LEGACY_RELAY_ENV_KEYS = [
  "LOCAL_CLI_ACP_RELAY_ENABLED",
  "LOCAL_CLI_ACP_RELAY_USER_ENABLED",
  "LOCAL_CLI_ACP_RELAY_PORT",
  "LOCAL_CLI_ACP_RELAY_AUTH_TOKEN",
  "LOCAL_CLI_ACP_DEFAULT_CWD",
  "LOCAL_CLI_ACP_ALLOWED_CWD_ROOTS",
  "LOCAL_CLI_ACP_HANDSHAKE_TIMEOUT_MS",
  "LOCAL_CLI_ACP_RUN_TIMEOUT_MS",
  "CLAUDE_CODE_ACP_COMMAND",
  "CLAUDE_CODE_ACP_ARGS"
] as const;
const AGENT_PLATFORM_DESKTOP_REMOVED_ENV_KEYS = [
  "AGENT_WS_ENABLED"
] as const;

export const PROCESS_EXEC_PATH_PLACEHOLDER = "{{processExecPath}}";
export const AGENT_WEBCLIENT_LEGACY_PLATFORM_URL_KEYS = new Set(["WS_BASE_URL", "VOICE_BASE_URL"]);
const AGENT_WEBCLIENT_DESKTOP_ENV_UPDATES = new Map([["DESKTOP_APP", "true"]]);
export const AGENT_PLATFORM_DEFAULT_AUTH_LOCAL_PUBLIC_KEY_FILE = path.join("configs", "local-public-key.pem").replace(/\\/gu, "/");

export function resolveAcpCommandForDesktop(env: Map<string, string>) {
  const currentAcpCommand = env.get("CLAUDE_CODE_ACP_COMMAND") ?? "";
  const currentAcpArgs = env.get("CLAUDE_CODE_ACP_ARGS") ?? "";
  const normalizedAcpCommand = currentAcpCommand.trim().replace(/^['"]|['"]$/gu, "");
  const usesDefaultAcpCommand =
    !currentAcpCommand
    || isCommandBasenameMatch(currentAcpCommand, "npx")
    || normalizedAcpCommand === "claude-code-acp";
  const usesDefaultAcpArgs =
    !currentAcpArgs || currentAcpArgs.trim() === DEFAULT_CLAUDE_CODE_ACP_ARGS;
  const resolvedClaudeCodeAcpBin = resolveCommandBin("claude-code-acp");
  if (resolvedClaudeCodeAcpBin && usesDefaultAcpCommand) {
    return {
      command: resolvedClaudeCodeAcpBin,
      args: usesDefaultAcpArgs ? "\"\"" : currentAcpArgs
    };
  }

  const resolvedNpxBin = resolveCommandBin("npx");
  if (resolvedNpxBin && (!currentAcpCommand || isCommandBasenameMatch(currentAcpCommand, "npx"))) {
    return {
      command: resolvedNpxBin,
      args: usesDefaultAcpArgs ? DEFAULT_CLAUDE_CODE_ACP_ARGS : currentAcpArgs
    };
  }

  if (usesDefaultAcpCommand) {
    console.warn(
      `[service-manager] Unable to resolve claude-code-acp or npx from Desktop PATH. Existing command="${currentAcpCommand || "(empty)"}"`
    );
  }
  return null;
}

export function applyAgentPlatformWindowsHostShellDefaults(
  env: Map<string, string>,
  updates: Map<string, string>,
  isWindows = IS_WINDOWS
) {
  if (!isWindows) {
    return false;
  }
  const hasExplicitShell =
    Boolean(env.get(AGENT_BASH_SHELL_EXECUTABLE_KEY)?.trim()) ||
    Boolean(env.get(AGENT_BASH_SHELL_ARGS_KEY)?.trim()) ||
    updates.has(AGENT_BASH_SHELL_EXECUTABLE_KEY) ||
    updates.has(AGENT_BASH_SHELL_ARGS_KEY);
  if (hasExplicitShell) {
    return false;
  }
  updates.set(AGENT_BASH_SHELL_EXECUTABLE_KEY, WINDOWS_AGENT_BASH_SHELL_EXECUTABLE);
  updates.set(AGENT_BASH_SHELL_ARGS_KEY, WINDOWS_AGENT_BASH_SHELL_ARGS);
  return true;
}

function shellQuoteEnvValue(value: string) {
  return `'${value.replace(/'/gu, "'\\''")}'`;
}

export function normalizeShellSourcedAgentPlatformEnvUpdates(updates: Map<string, string>) {
  const acpArgs = updates.get("CLAUDE_CODE_ACP_ARGS")?.trim() ?? "";
  if (/\s/u.test(acpArgs) && !/^(['"]).*\1$/u.test(acpArgs)) {
    updates.set("CLAUDE_CODE_ACP_ARGS", shellQuoteEnvValue(acpArgs));
  }
}

export function normalizePreservedBuiltinEnvForInstall(service: ServiceDefinition, content: string) {
  if (service.id === "agent-container-hub") {
    return {
      content: normalizeAgentContainerHubEnvContentForDesktop(content)
    };
  }

  if (service.id === "agent-platform") {
    return {
      content: normalizeAgentPlatformEnvContentForRuntime(content)
    };
  }

  return {
    content
  };
}

const AGENT_CONTAINER_HUB_DESKTOP_MANAGED_PATH_KEYS = [
  "STATE_DB_PATH",
  "CONFIG_ROOT",
  "ROOTFS_ROOT",
  "BUILD_ROOT",
  "SESSION_MOUNT_TEMPLATE_ROOT"
] as const;

function isAbsoluteServiceEnvPath(value: string) {
  return path.isAbsolute(value) || path.posix.isAbsolute(value) || path.win32.isAbsolute(value);
}

export function normalizeAgentContainerHubEnvContentForDesktop(content: string) {
  const nextLines = content
    .split(/\r?\n/u)
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        return true;
      }
      const separatorIndex = trimmed.indexOf("=");
      if (separatorIndex <= 0) {
        return true;
      }
      const key = trimmed.slice(0, separatorIndex).trim();
      if (!AGENT_CONTAINER_HUB_DESKTOP_MANAGED_PATH_KEYS.includes(
        key as (typeof AGENT_CONTAINER_HUB_DESKTOP_MANAGED_PATH_KEYS)[number]
      )) {
        return true;
      }

      const value = trimmed.slice(separatorIndex + 1).trim().replace(/^['"]|['"]$/gu, "");
      return isAbsoluteServiceEnvPath(value);
    });

  if (nextLines.length === 0) {
    return "";
  }
  return `${nextLines.join("\n").replace(/\n+$/u, "")}\n`;
}

function removeEnvKeysFromContent(content: string, keys: readonly string[]) {
  const blocked = new Set(keys);
  const nextLines = content
    .split(/\r?\n/u)
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        return true;
      }
      const separatorIndex = trimmed.indexOf("=");
      if (separatorIndex <= 0) {
        return true;
      }
      const key = trimmed.slice(0, separatorIndex).trim();
      return !blocked.has(key);
    });

  if (nextLines.length === 0) {
    return "";
  }
  return `${nextLines.join("\n").replace(/\n+$/u, "")}\n`;
}

function removeAgentWebclientManagedNodeBinPlaceholder(content: string) {
  const nextLines = content
    .split(/\r?\n/u)
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        return true;
      }
      const separatorIndex = trimmed.indexOf("=");
      if (separatorIndex <= 0) {
        return true;
      }

      const key = trimmed.slice(0, separatorIndex).trim();
      const value = trimmed.slice(separatorIndex + 1).trim().replace(/^['"]|['"]$/gu, "");
      return key !== "NODE_BIN" || value !== PROCESS_EXEC_PATH_PLACEHOLDER;
    });

  if (nextLines.length === 0) {
    return "";
  }
  return `${nextLines.join("\n").replace(/\n+$/u, "")}\n`;
}

export function isManagedAgentPlatformAuthLocalPublicKeyPath(value: string, layout?: ServiceLayout) {
  const unquoted = value.trim().replace(/^['"]|['"]$/gu, "");
  const normalized = normalizeConfigPath(unquoted);
  if (
    normalized === AGENT_PLATFORM_DEFAULT_AUTH_LOCAL_PUBLIC_KEY_FILE ||
    normalized === "local-public-key.pem"
  ) {
    return true;
  }

  if (!layout) {
    return false;
  }

  const managedPath = normalizeConfigPath(resolveConfigPath(layout, AGENT_PLATFORM_DEFAULT_AUTH_LOCAL_PUBLIC_KEY_FILE));
  return normalized === managedPath;
}

function removeDesktopManagedAgentPlatformEnvContent(content: string) {
  return removeEnvKeysFromContent(content, AGENT_PLATFORM_DESKTOP_REMOVED_ENV_KEYS);
}

export function normalizeAgentWebclientEnvContentForDesktop(content: string) {
  return upsertEnvFileContent(
    removeAgentWebclientManagedNodeBinPlaceholder(content),
    AGENT_WEBCLIENT_DESKTOP_ENV_UPDATES,
    { uncommentExisting: true }
  );
}

export function normalizeAgentPlatformEnvContentForRuntime(content: string, _layout?: ServiceLayout) {
  const removedRuntimePathKeys = agentPlatformDesktopRuntimePaths.map(([key]) => key);
  return removeDesktopManagedAgentPlatformEnvContent(
    removeEnvKeysFromContent(
      removeEnvKeysFromContent(content, AGENT_PLATFORM_LEGACY_RELAY_ENV_KEYS),
      removedRuntimePathKeys
    )
  );
}

export function normalizeAgentPlatformEnvContentForSave(content: string) {
  return normalizeAgentPlatformEnvContentForRuntime(content);
}

function resolveLocalCliAcpRelayDefaultCwd(app?: App | null) {
  return resolveDesktopDir(app);
}

export async function ensureLocalCliAcpRelayDesktopConfig(app: App, layout: ServiceLayout) {
  const envPath = layout.envPath;
  const env = readEnvFile(envPath);
  const updates = new Map<string, string>();

  if (!env.get("PORT")?.trim()) {
    updates.set("PORT", DEFAULT_LOCAL_CLI_ACP_RELAY_PORT);
  }
  if (!env.get("DEFAULT_CWD")?.trim()) {
    updates.set("DEFAULT_CWD", resolveLocalCliAcpRelayDefaultCwd(app));
  }
  if (!env.get("ALLOWED_CWD_ROOTS")?.trim()) {
    updates.set("ALLOWED_CWD_ROOTS", resolveLocalCliAcpRelayDefaultCwd(app));
  }
  if (!env.get("HANDSHAKE_TIMEOUT_MS")?.trim()) {
    updates.set("HANDSHAKE_TIMEOUT_MS", DEFAULT_LOCAL_CLI_ACP_HANDSHAKE_TIMEOUT_MS);
  }
  if (!env.get("RUN_TIMEOUT_MS")?.trim()) {
    updates.set("RUN_TIMEOUT_MS", DEFAULT_LOCAL_CLI_ACP_RUN_TIMEOUT_MS);
  }
  const effectiveEnv = new Map(env);
  for (const [key, value] of updates) {
    effectiveEnv.set(key, value);
  }
  const resolvedAcpCommand = resolveAcpCommandForDesktop(effectiveEnv);
  if (resolvedAcpCommand) {
    updates.set("CLAUDE_CODE_ACP_COMMAND", resolvedAcpCommand.command);
    updates.set("CLAUDE_CODE_ACP_ARGS", resolvedAcpCommand.args);
  }

  if (updates.size > 0) {
    normalizeShellSourcedAgentPlatformEnvUpdates(updates);
    writeEnvFileUpdates(envPath, updates);
  }
}
