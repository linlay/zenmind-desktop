import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync as nodeExecFileSync } from "node:child_process";
import type { App } from "electron";

export type HostStartupItemSource =
  | "mac_login_item"
  | "mac_user_launch_agent"
  | "mac_system_launch_agent"
  | "mac_system_launch_daemon"
  | "win_user_startup_folder"
  | "win_common_startup_folder"
  | "win_registry_hkcu_run"
  | "win_registry_hklm_run";

export type HostStartupItem = {
  id: string;
  name: string;
  source: HostStartupItemSource;
  path?: string;
  command?: string;
  enabled: boolean;
  removable: boolean;
  requiresAdmin: boolean;
  platform: string;
};

export type HostStartupListResult = {
  ok: boolean;
  platform: string;
  items: HostStartupItem[];
  message: string;
  error?: string;
};

export type HostStartupRemoveFailure = {
  target: string;
  item?: HostStartupItem;
  reason: string;
};

export type HostStartupRemoveResult = {
  ok: boolean;
  platform: string;
  requestedTargets: string[];
  removed: HostStartupItem[];
  failed: HostStartupRemoveFailure[];
  remaining: HostStartupItem[];
  verification: {
    beforeCount: number;
    afterCount: number;
    removedCount: number;
    failedCount: number;
  };
  message: string;
};

export type WindowsRegistryRunValue = {
  name: string;
  command: string;
};

export type WindowsRegistrySnapshot = {
  hkcuRun?: WindowsRegistryRunValue[];
  hklmRun?: WindowsRegistryRunValue[];
};

type ExecFileSyncLike = (
  file: string,
  args?: readonly string[],
  options?: { encoding?: BufferEncoding; stdio?: "ignore" | "pipe" }
) => string | Buffer;

export type HostStartupEnvironment = {
  platform?: NodeJS.Platform | string;
  homeDir?: string;
  appDataDir?: string;
  programDataDir?: string;
  macUserLaunchAgentsDir?: string;
  macSystemLaunchAgentsDir?: string;
  macSystemLaunchDaemonsDir?: string;
  windowsUserStartupDir?: string;
  windowsCommonStartupDir?: string;
  execFileSync?: ExecFileSyncLike;
  windowsRegistryProvider?: () => WindowsRegistrySnapshot;
  deleteWindowsRegistryValue?: (hive: "HKCU" | "HKLM", name: string) => void;
};

type MatchedTarget = {
  target: string;
  item?: HostStartupItem;
  reason?: string;
};

function getPlatform(env: HostStartupEnvironment = {}) {
  return String(env.platform || process.platform);
}

function getHomeDir(app: App, env: HostStartupEnvironment = {}) {
  if (env.homeDir) {
    return env.homeDir;
  }
  try {
    return app.getPath("home");
  } catch {
    return os.homedir();
  }
}

function execText(env: HostStartupEnvironment, file: string, args: readonly string[]) {
  const execFileSync = env.execFileSync ?? nodeExecFileSync;
  const result = execFileSync(file, args, { encoding: "utf8", stdio: "pipe" });
  return Buffer.isBuffer(result) ? result.toString("utf8") : String(result ?? "");
}

function normalizeKey(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s._\-:：/\\]+/gu, "");
}

function startupItemId(source: HostStartupItemSource, name: string, sourcePath?: string) {
  const basis = sourcePath || name;
  return `${source}:${normalizeKey(basis) || normalizeKey(name)}`;
}

function readDirectoryEntries(dirPath: string) {
  if (!fs.existsSync(dirPath)) {
    return [];
  }
  try {
    return fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }
}

function parsePlistValue(content: string, key: string) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = content.match(new RegExp(`<key>\\s*${escapedKey}\\s*<\\/key>\\s*<string>([^<]+)<\\/string>`, "u"));
  return match?.[1]?.trim() || "";
}

function parsePlistFirstProgramArgument(content: string) {
  const match = content.match(/<key>\s*ProgramArguments\s*<\/key>\s*<array>\s*<string>([^<]+)<\/string>/u);
  return match?.[1]?.trim() || parsePlistValue(content, "Program");
}

function listLaunchPlists(dirPath: string, source: HostStartupItemSource, platform: string) {
  const requiresAdmin = source !== "mac_user_launch_agent";
  return readDirectoryEntries(dirPath)
    .filter((entry) => entry.isFile() && entry.name.endsWith(".plist"))
    .map((entry): HostStartupItem => {
      const filePath = path.join(dirPath, entry.name);
      let content = "";
      try {
        content = fs.readFileSync(filePath, "utf8");
      } catch {
        content = "";
      }
      const name = parsePlistValue(content, "Label") || path.basename(entry.name, ".plist");
      return {
        id: startupItemId(source, name, filePath),
        name,
        source,
        path: filePath,
        command: parsePlistFirstProgramArgument(content) || undefined,
        enabled: true,
        removable: !requiresAdmin,
        requiresAdmin,
        platform
      };
    });
}

function parseMacLoginItems(output: string, platform: string): HostStartupItem[] {
  return output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line): HostStartupItem | null => {
      const [name, itemPath] = line.split("\t");
      const itemName = (name || "").trim();
      if (!itemName) {
        return null;
      }
      return {
        id: startupItemId("mac_login_item", itemName, itemPath),
        name: itemName,
        source: "mac_login_item" as const,
        path: itemPath?.trim() || undefined,
        enabled: true,
        removable: true,
        requiresAdmin: false,
        platform
      };
    })
    .filter((item): item is HostStartupItem => Boolean(item));
}

function listMacLoginItems(env: HostStartupEnvironment, platform: string) {
  const script = [
    "tell application \"System Events\"",
    "set output to \"\"",
    "repeat with itemRef in login items",
    "set output to output & (name of itemRef as text) & tab & (path of itemRef as text) & linefeed",
    "end repeat",
    "return output",
    "end tell"
  ].join("\n");
  try {
    return parseMacLoginItems(execText(env, "/usr/bin/osascript", ["-e", script]), platform);
  } catch {
    return [];
  }
}

function listMacStartupItems(app: App, env: HostStartupEnvironment, platform: string): HostStartupItem[] {
  const homeDir = getHomeDir(app, env);
  const userLaunchAgentsDir = env.macUserLaunchAgentsDir ?? path.join(homeDir, "Library", "LaunchAgents");
  const systemLaunchAgentsDir = env.macSystemLaunchAgentsDir ?? "/Library/LaunchAgents";
  const systemLaunchDaemonsDir = env.macSystemLaunchDaemonsDir ?? "/Library/LaunchDaemons";
  return [
    ...listMacLoginItems(env, platform),
    ...listLaunchPlists(userLaunchAgentsDir, "mac_user_launch_agent", platform),
    ...listLaunchPlists(systemLaunchAgentsDir, "mac_system_launch_agent", platform),
    ...listLaunchPlists(systemLaunchDaemonsDir, "mac_system_launch_daemon", platform)
  ];
}

function defaultWindowsUserStartupDir(app: App, env: HostStartupEnvironment) {
  const appData = env.appDataDir || process.env.APPDATA || path.join(getHomeDir(app, env), "AppData", "Roaming");
  return path.join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
}

function defaultWindowsCommonStartupDir(env: HostStartupEnvironment) {
  const programData = env.programDataDir || process.env.ProgramData || "C:\\ProgramData";
  return path.join(programData, "Microsoft", "Windows", "Start Menu", "Programs", "StartUp");
}

function listWindowsStartupFolder(dirPath: string, source: HostStartupItemSource, platform: string) {
  const requiresAdmin = source === "win_common_startup_folder";
  return readDirectoryEntries(dirPath)
    .filter((entry) => entry.isFile())
    .map((entry): HostStartupItem => {
      const filePath = path.join(dirPath, entry.name);
      return {
        id: startupItemId(source, path.basename(entry.name, path.extname(entry.name)), filePath),
        name: path.basename(entry.name, path.extname(entry.name)),
        source,
        path: filePath,
        enabled: true,
        removable: !requiresAdmin,
        requiresAdmin,
        platform
      };
    });
}

function parseWindowsRegistryRunValues(output: string): WindowsRegistryRunValue[] {
  return output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .map((line) => {
      const match = line.match(/^(.+?)\s+REG_\w+\s+(.+)$/u);
      return match?.[1] && match?.[2]
        ? { name: match[1].trim(), command: match[2].trim() }
        : null;
    })
    .filter((item): item is WindowsRegistryRunValue => Boolean(item));
}

function queryWindowsRunKey(env: HostStartupEnvironment, key: string) {
  try {
    return parseWindowsRegistryRunValues(execText(env, "reg.exe", ["query", key]));
  } catch {
    return [];
  }
}

function readWindowsRegistrySnapshot(env: HostStartupEnvironment): WindowsRegistrySnapshot {
  if (env.windowsRegistryProvider) {
    return env.windowsRegistryProvider();
  }
  return {
    hkcuRun: queryWindowsRunKey(env, "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run"),
    hklmRun: queryWindowsRunKey(env, "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Run")
  };
}

function registryItems(values: WindowsRegistryRunValue[] | undefined, source: HostStartupItemSource, platform: string) {
  const requiresAdmin = source === "win_registry_hklm_run";
  return (values ?? []).map((value): HostStartupItem => ({
    id: startupItemId(source, value.name),
    name: value.name,
    source,
    command: value.command,
    enabled: true,
    removable: !requiresAdmin,
    requiresAdmin,
    platform
  }));
}

function listWindowsStartupItems(app: App, env: HostStartupEnvironment, platform: string): HostStartupItem[] {
  const registry = readWindowsRegistrySnapshot(env);
  return [
    ...listWindowsStartupFolder(env.windowsUserStartupDir ?? defaultWindowsUserStartupDir(app, env), "win_user_startup_folder", platform),
    ...listWindowsStartupFolder(env.windowsCommonStartupDir ?? defaultWindowsCommonStartupDir(env), "win_common_startup_folder", platform),
    ...registryItems(registry.hkcuRun, "win_registry_hkcu_run", platform),
    ...registryItems(registry.hklmRun, "win_registry_hklm_run", platform)
  ];
}

export function listHostStartupItems(app: App, env: HostStartupEnvironment = {}): HostStartupListResult {
  const platform = getPlatform(env);
  if (platform === "darwin") {
    const items = listMacStartupItems(app, env, platform);
    return { ok: true, platform, items, message: `已读取 ${items.length} 个 macOS 开机启动项。` };
  }
  if (platform === "win32" || platform === "windows") {
    const items = listWindowsStartupItems(app, env, platform);
    return { ok: true, platform, items, message: `已读取 ${items.length} 个 Windows 开机启动项。` };
  }
  return {
    ok: false,
    platform,
    items: [],
    error: "platform_unsupported",
    message: "当前平台暂不支持枚举开机启动项。"
  };
}

function findTargetItem(target: string, items: HostStartupItem[]): MatchedTarget {
  const key = normalizeKey(target);
  if (!key) {
    return { target, reason: "目标为空。" };
  }
  const byId = items.filter((item) => normalizeKey(item.id) === key);
  if (byId.length === 1) {
    return { target, item: byId[0] };
  }
  const byName = items.filter((item) => normalizeKey(item.name) === key);
  if (byName.length === 1) {
    return { target, item: byName[0] };
  }
  const byContains = items.filter((item) => normalizeKey(item.name).includes(key) || key.includes(normalizeKey(item.name)));
  if (byContains.length === 1) {
    return { target, item: byContains[0] };
  }
  if (byId.length + byName.length + byContains.length > 1) {
    return { target, reason: "匹配到多个启动项，请提供更精确的名称。" };
  }
  return { target, reason: "没有找到匹配的开机启动项。" };
}

function sameStartupItem(a: HostStartupItem, b: HostStartupItem) {
  if (a.id && b.id && a.id === b.id) {
    return true;
  }
  return a.source === b.source && normalizeKey(a.name) === normalizeKey(b.name);
}

function removeMacLoginItem(item: HostStartupItem, env: HostStartupEnvironment) {
  const safeName = item.name.replace(/\\/gu, "\\\\").replace(/"/gu, "\\\"");
  execText(env, "/usr/bin/osascript", ["-e", `tell application "System Events" to delete login item "${safeName}"`]);
}

function removeMacUserLaunchAgent(item: HostStartupItem, env: HostStartupEnvironment) {
  if (!item.path) {
    throw new Error("缺少 LaunchAgent plist 路径。");
  }
  const label = item.name;
  try {
    execText(env, "/bin/launchctl", ["bootout", `gui/${typeof process.getuid === "function" ? process.getuid() : 501}`, label]);
  } catch {
    // A plist may exist without a currently-loaded job; deleting the plist is the durable startup removal.
  }
  fs.rmSync(item.path, { force: false });
}

function removeWindowsStartupFolderItem(item: HostStartupItem) {
  if (!item.path) {
    throw new Error("缺少启动文件路径。");
  }
  fs.rmSync(item.path, { force: false });
}

function removeWindowsRegistryItem(item: HostStartupItem, env: HostStartupEnvironment) {
  const hive = item.source === "win_registry_hkcu_run" ? "HKCU" : "HKLM";
  if (env.deleteWindowsRegistryValue) {
    env.deleteWindowsRegistryValue(hive, item.name);
    return;
  }
  const key = `${hive}\\Software\\Microsoft\\Windows\\CurrentVersion\\Run`;
  execText(env, "reg.exe", ["delete", key, "/v", item.name, "/f"]);
}

function removeStartupItem(item: HostStartupItem, env: HostStartupEnvironment) {
  switch (item.source) {
    case "mac_login_item":
      removeMacLoginItem(item, env);
      return;
    case "mac_user_launch_agent":
      removeMacUserLaunchAgent(item, env);
      return;
    case "win_user_startup_folder":
      removeWindowsStartupFolderItem(item);
      return;
    case "win_registry_hkcu_run":
      removeWindowsRegistryItem(item, env);
      return;
    default:
      throw new Error(item.requiresAdmin ? "系统级启动项需要管理员权限，未执行移除。" : "该启动项暂不支持自动移除。");
  }
}

function buildRemoveMessage(result: Omit<HostStartupRemoveResult, "message">) {
  const parts = [];
  if (result.removed.length > 0) {
    parts.push(`已确认移除 ${result.removed.length} 项：${result.removed.map((item) => item.name).join("、")}。`);
  }
  if (result.failed.length > 0) {
    parts.push(`未确认移除 ${result.failed.length} 项：${result.failed.map((item) => `${item.target}（${item.reason}）`).join("；")}。`);
  }
  parts.push(result.remaining.length > 0
    ? `当前剩余启动项：${result.remaining.map((item) => item.name).join("、")}。`
    : "当前剩余启动项：无。");
  return parts.join("\n");
}

export function removeHostStartupItems(
  app: App,
  input: { targets?: string[]; dryRun?: boolean },
  env: HostStartupEnvironment = {}
): HostStartupRemoveResult {
  const requestedTargets = Array.isArray(input.targets)
    ? input.targets.map((target) => String(target ?? "").trim()).filter(Boolean)
    : [];
  const before = listHostStartupItems(app, env);
  const removedAttempts: HostStartupItem[] = [];
  const failed: HostStartupRemoveFailure[] = [];
  if (!before.ok) {
    const result = {
      ok: false,
      platform: before.platform,
      requestedTargets,
      removed: [],
      failed: requestedTargets.map((target) => ({ target, reason: before.message })),
      remaining: [],
      verification: {
        beforeCount: 0,
        afterCount: 0,
        removedCount: 0,
        failedCount: requestedTargets.length
      }
    };
    return { ...result, message: buildRemoveMessage(result) };
  }

  for (const target of requestedTargets) {
    const match = findTargetItem(target, before.items);
    if (!match.item) {
      failed.push({ target, reason: match.reason || "没有找到匹配的开机启动项。" });
      continue;
    }
    if (match.item.requiresAdmin || !match.item.removable) {
      failed.push({ target, item: match.item, reason: "系统级启动项需要管理员权限，未执行移除。" });
      continue;
    }
    if (input.dryRun) {
      failed.push({ target, item: match.item, reason: "dryRun=true，仅预览未移除。" });
      continue;
    }
    try {
      removeStartupItem(match.item, env);
      removedAttempts.push(match.item);
    } catch (error) {
      failed.push({ target, item: match.item, reason: error instanceof Error ? error.message : String(error) });
    }
  }

  const after = listHostStartupItems(app, env);
  const remaining = after.items;
  const verifiedRemoved: HostStartupItem[] = [];
  for (const item of removedAttempts) {
    if (remaining.some((candidate) => sameStartupItem(candidate, item))) {
      failed.push({ target: item.name, item, reason: "复查仍存在，未确认移除。" });
    } else {
      verifiedRemoved.push(item);
    }
  }

  const result = {
    ok: failed.length === 0,
    platform: before.platform,
    requestedTargets,
    removed: verifiedRemoved,
    failed,
    remaining,
    verification: {
      beforeCount: before.items.length,
      afterCount: remaining.length,
      removedCount: verifiedRemoved.length,
      failedCount: failed.length
    }
  };
  return { ...result, message: buildRemoveMessage(result) };
}

export const __testInternals = {
  normalizeKey,
  parseMacLoginItems,
  parseWindowsRegistryRunValues,
  startupItemId
};
