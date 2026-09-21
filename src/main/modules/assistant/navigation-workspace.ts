import { type PlatformAgentSummary } from "./navigation-contracts";
import { toText } from "./navigation-values";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { type AssistantNavAgentItem } from "../../../shared/contracts";

export type AssistantGitBranchCacheEntry = {
  branch: string;
  expiresAt: number;
};

export type AssistantGitBranchCommandRunner = (
  command: string,
  args: string[],
) => Promise<string>;

export const NAVIGATION_GIT_BRANCH_CACHE_MS = 15_000;

export const NAVIGATION_GIT_BRANCH_TIMEOUT_MS = 1_000;

export const navigationGitBranchCache = new Map<string, AssistantGitBranchCacheEntry>();

export function readAgentWorkspaceDir(agent: PlatformAgentSummary) {
  return (
    toText(agent.workspaceDir) ||
    toText(agent.workspaceRoot) ||
    toText(agent.workspace?.root) ||
    toText(agent.runtimeConfig?.workspaceRoot)
  );
}

export function checkWorkspaceDirExists(workspaceDir: string) {
  if (!workspaceDir || workspaceDir === "@chat") {
    return false;
  }
  try {
    return fs.existsSync(workspaceDir) && fs.statSync(workspaceDir).isDirectory();
  } catch {
    return false;
  }
}

export function resolveAssistantGitExecutable(platform: NodeJS.Platform) {
  if (platform === "win32") {
    return "git.exe";
  }
  if (platform === "darwin") {
    return "git";
  }
  return "git";
}

export function runAssistantGitBranchCommand(command: string, args: string[]) {
  return new Promise<string>((resolve) => {
    execFile(
      command,
      args,
      {
        encoding: "utf8",
        timeout: NAVIGATION_GIT_BRANCH_TIMEOUT_MS,
        windowsHide: true,
      },
      (error, stdout) => {
        resolve(error || typeof stdout !== "string" ? "" : stdout.trim());
      },
    );
  });
}

export async function resolveAssistantWorkspaceGitBranch(
  workspaceDir: string,
  options: {
    platform?: NodeJS.Platform;
    now?: () => number;
    cache?: Map<string, AssistantGitBranchCacheEntry>;
    runCommand?: AssistantGitBranchCommandRunner;
  } = {},
) {
  const normalizedWorkspaceDir = workspaceDir.trim();
  if (!checkWorkspaceDirExists(normalizedWorkspaceDir)) {
    return "";
  }

  const platform = options.platform ?? process.platform;
  const now = options.now ?? Date.now;
  const cache = options.cache ?? navigationGitBranchCache;
  const cacheKey = `${platform}:${normalizedWorkspaceDir}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > now()) {
    return cached.branch;
  }

  const runCommand = options.runCommand ?? runAssistantGitBranchCommand;
  let branch = "";
  try {
    branch = (await runCommand(
      resolveAssistantGitExecutable(platform),
      ["-C", normalizedWorkspaceDir, "branch", "--show-current"],
    )).trim();
  } catch {
    branch = "";
  }

  cache.set(cacheKey, {
    branch,
    expiresAt: now() + NAVIGATION_GIT_BRANCH_CACHE_MS,
  });
  return branch;
}

export function isWorkspaceProjectAgent(agent: AssistantNavAgentItem) {
  return Boolean(agent.workspaceDir?.trim());
}

export async function enrichNavigationAgentsWithGitBranches(
  items: AssistantNavAgentItem[],
  resolveGitBranch: (workspaceDir: string) => Promise<string> = resolveAssistantWorkspaceGitBranch,
) {
  const branchesByWorkspace = new Map<string, Promise<string>>();
  for (const agent of items) {
    const workspaceDir = agent.workspaceDir?.trim() ?? "";
    if (!isWorkspaceProjectAgent(agent) || !workspaceDir || agent.workspaceDirExists === false) {
      continue;
    }
    if (!branchesByWorkspace.has(workspaceDir)) {
      branchesByWorkspace.set(workspaceDir, resolveGitBranch(workspaceDir));
    }
  }

  if (branchesByWorkspace.size === 0) {
    return items;
  }

  const resolvedBranches = new Map<string, string>();
  await Promise.all(
    [...branchesByWorkspace.entries()].map(async ([workspaceDir, branch]) => {
      resolvedBranches.set(workspaceDir, await branch);
    }),
  );
  return items.map((agent) => {
    const workspaceDir = agent.workspaceDir?.trim() ?? "";
    const gitBranch = workspaceDir ? resolvedBranches.get(workspaceDir)?.trim() ?? "" : "";
    return gitBranch ? { ...agent, gitBranch } : agent;
  });
}
