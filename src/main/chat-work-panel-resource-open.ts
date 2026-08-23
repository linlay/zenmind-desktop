import fs from "node:fs";
import path from "node:path";
import { shell as electronShell, type App } from "electron";
import type {
  ChatWorkPanelOpenLocalResourceRequest,
  ChatWorkPanelOpenLocalResourceResult,
} from "../shared/chat-work-panel-tab-context-menu";
import { t } from "./i18n/main-i18n";
import { resolvePreferredAgentPlatformRuntimeRoot } from "./services/manager/runtime-paths";

type OpenChatResourceDependencies = {
  app: App;
  platform?: NodeJS.Platform | string;
  resolveRuntimeRoot?: (app: App) => string;
  existsSync?: (targetPath: string) => boolean;
  realpathSync?: (targetPath: string) => string;
  statSync?: (targetPath: string) => { isFile(): boolean };
  openPath?: (targetPath: string) => Promise<string>;
  showItemInFolder?: (targetPath: string) => void;
};

const RESOURCE_ERROR_KEYS = {
  openDefault: {
    invalidPath: "chatWorkPanel.openDefault.invalidPath",
    notFound: "chatWorkPanel.openDefault.notFound",
    notFile: "chatWorkPanel.openDefault.notFile",
    outsideChat: "chatWorkPanel.openDefault.outsideChat",
  },
  reveal: {
    invalidPath: "chatWorkPanel.reveal.invalidPath",
    notFound: "chatWorkPanel.reveal.notFound",
    notFile: "chatWorkPanel.reveal.notFile",
    outsideChat: "chatWorkPanel.reveal.outsideChat",
  },
} as const;

type LocalResourceAction = keyof typeof RESOURCE_ERROR_KEYS;

function platformPathApi(platform: NodeJS.Platform | string, rootPath: string) {
  if (platform === "win32") {
    return path.posix.isAbsolute(rootPath) ? path.posix : path.win32;
  }
  return path.posix;
}

function fail(
  code: NonNullable<ChatWorkPanelOpenLocalResourceResult["code"]>,
  message: string,
  targetPath = "",
): ChatWorkPanelOpenLocalResourceResult {
  return { ok: false, code, ...(targetPath ? { path: targetPath } : {}), message };
}

function normalizeChatId(value: string) {
  const chatId = value.trim();
  if (
    !chatId ||
    chatId.length > 512 ||
    chatId === "." ||
    chatId === ".." ||
    /[/\\\u0000-\u001f\u007f]/u.test(chatId)
  ) {
    return "";
  }
  return chatId;
}

function normalizeResourcePath(
  value: string,
  profile: ChatWorkPanelOpenLocalResourceRequest["profile"],
) {
  const rawPath = value.replace(/\\/gu, "/");
  if (
    !rawPath ||
    rawPath.length > 2_048 ||
    rawPath.startsWith("/") ||
    /^[a-z]:\//iu.test(rawPath) ||
    /[\u0000-\u001f\u007f]/u.test(rawPath)
  ) {
    return "";
  }
  const parts = rawPath.split("/").filter((part) => part && part !== ".");
  const expectedRoot = profile === "artifact" ? "artifacts" : "references";
  if (parts.length < 2 || parts[0] !== expectedRoot || parts.some((part) => part === "..")) {
    return "";
  }
  return parts.join("/");
}

function isInside(parentPath: string, candidatePath: string, pathApi: typeof path.posix | typeof path.win32) {
  const relative = pathApi.relative(parentPath, candidatePath);
  return Boolean(relative) && !relative.startsWith("..") && !pathApi.isAbsolute(relative);
}

export function normalizeChatWorkPanelOpenLocalResourceRequest(
  value: unknown,
): ChatWorkPanelOpenLocalResourceRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 3 ||
    typeof record.ownerChatId !== "string" ||
    typeof record.relativePath !== "string" ||
    (record.profile !== "artifact" && record.profile !== "reference")
  ) {
    return null;
  }
  const ownerChatId = normalizeChatId(record.ownerChatId);
  const relativePath = normalizeResourcePath(record.relativePath, record.profile);
  return ownerChatId && relativePath
    ? { ownerChatId, relativePath, profile: record.profile }
    : null;
}

function resolveChatWorkPanelResourceFile(
  request: ChatWorkPanelOpenLocalResourceRequest,
  dependencies: OpenChatResourceDependencies,
  action: LocalResourceAction,
): ChatWorkPanelOpenLocalResourceResult {
  const errorKeys = RESOURCE_ERROR_KEYS[action];
  const normalized = normalizeChatWorkPanelOpenLocalResourceRequest(request);
  if (!normalized) {
    return fail("invalid_request", t(errorKeys.invalidPath));
  }
  const platform = dependencies.platform ?? process.platform;
  if (platform === "win32" && normalized.relativePath.includes(":")) {
    return fail("invalid_request", t(errorKeys.invalidPath));
  }
  const runtimeRoot = (dependencies.resolveRuntimeRoot ?? resolvePreferredAgentPlatformRuntimeRoot)(
    dependencies.app,
  );
  const pathApi = platformPathApi(platform, runtimeRoot);
  const chatRoot = pathApi.resolve(pathApi.join(runtimeRoot, "chats", normalized.ownerChatId));
  const candidatePath = pathApi.resolve(pathApi.join(chatRoot, normalized.relativePath));
  if (!isInside(chatRoot, candidatePath, pathApi)) {
    return fail("path_outside_chat", t(errorKeys.outsideChat), candidatePath);
  }

  const existsSync = dependencies.existsSync ?? fs.existsSync;
  const realpathSync = dependencies.realpathSync ?? fs.realpathSync.native;
  const statSync = dependencies.statSync ?? fs.statSync;
  if (!existsSync(chatRoot) || !existsSync(candidatePath)) {
    return fail("not_found", t(errorKeys.notFound), candidatePath);
  }

  let realChatRoot = "";
  let realCandidatePath = "";
  try {
    realChatRoot = realpathSync(chatRoot);
    realCandidatePath = realpathSync(candidatePath);
  } catch {
    return fail("not_found", t(errorKeys.notFound), candidatePath);
  }
  if (!isInside(realChatRoot, realCandidatePath, pathApi)) {
    return fail("path_outside_chat", t(errorKeys.outsideChat), realCandidatePath);
  }
  if (!statSync(realCandidatePath).isFile()) {
    return fail("not_file", t(errorKeys.notFile), realCandidatePath);
  }

  return { ok: true, path: realCandidatePath };
}

export async function openChatWorkPanelResourceInDefaultApp(
  request: ChatWorkPanelOpenLocalResourceRequest,
  dependencies: OpenChatResourceDependencies,
): Promise<ChatWorkPanelOpenLocalResourceResult> {
  const resolved = resolveChatWorkPanelResourceFile(request, dependencies, "openDefault");
  if (!resolved.ok || !resolved.path) return resolved;

  try {
    const openError = await (dependencies.openPath ?? electronShell.openPath)(resolved.path);
    if (openError) return fail("open_failed", openError, resolved.path);
    return {
      ok: true,
      path: resolved.path,
      message: t("chatWorkPanel.openDefault.opened"),
    };
  } catch (error) {
    return fail(
      "open_failed",
      error instanceof Error ? error.message : String(error),
      resolved.path,
    );
  }
}

export async function revealChatWorkPanelResourceInFileManager(
  request: ChatWorkPanelOpenLocalResourceRequest,
  dependencies: OpenChatResourceDependencies,
): Promise<ChatWorkPanelOpenLocalResourceResult> {
  const resolved = resolveChatWorkPanelResourceFile(request, dependencies, "reveal");
  if (!resolved.ok || !resolved.path) return resolved;

  try {
    (dependencies.showItemInFolder ?? electronShell.showItemInFolder)(resolved.path);
    return {
      ok: true,
      path: resolved.path,
      message: t("chatWorkPanel.reveal.revealed"),
    };
  } catch (error) {
    return fail(
      "open_failed",
      error instanceof Error ? error.message : String(error),
      resolved.path,
    );
  }
}
