import {
  isCommandBasenameMatch,
  resolveCommandBin
} from "./command-env";

export const LOCAL_CLI_ACP_RELAY_PLUGIN_ID = "local-cli-acp-relay";
const DEFAULT_CLAUDE_CODE_ACP_ARGS = "-y @zed-industries/claude-code-acp";

export const PROCESS_EXEC_PATH_PLACEHOLDER = "{{processExecPath}}";

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
