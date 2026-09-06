import fs from "node:fs";
import path from "node:path";
import { shell as electronShell, type App } from "electron";
import type {
  ChatWorkPanelLocalResourceErrorCode,
  ChatWorkPanelOpenLocalResourceRequest,
  ChatWorkPanelOpenLocalResourceResult,
} from "../../../shared/chat-work-panel-tab-context-menu";
import { t } from "../../support/i18n/main-i18n";
import { resolvePreferredAgentPlatformRuntimeRoot } from "../services";

export type OpenChatResourceDependencies = {
  app: App;
  platform?: NodeJS.Platform | string;
  resolveRuntimeRoot?: (app: App) => string;
  existsSync?: (targetPath: string) => boolean;
  realpathSync?: (targetPath: string) => string;
  statSync?: (targetPath: string) => { isFile(): boolean };
  openPath?: (targetPath: string) => Promise<string>;
  showItemInFolder?: (targetPath: string) => void;
};

const RESOURCE_RESULT_KEYS = {
  openDefault: {
    success: "chatWorkPanel.openDefault.opened",
    invalid_request: "chatWorkPanel.openDefault.invalidPath",
    not_found: "chatWorkPanel.openDefault.notFound",
    not_file: "chatWorkPanel.openDefault.notFile",
    path_outside_chat: "chatWorkPanel.openDefault.outsideChat",
    open_failed: "chatWorkPanel.openDefault.failed",
  },
  reveal: {
    success: "chatWorkPanel.reveal.revealed",
    invalid_request: "chatWorkPanel.reveal.invalidPath",
    not_found: "chatWorkPanel.reveal.notFound",
    not_file: "chatWorkPanel.reveal.notFile",
    path_outside_chat: "chatWorkPanel.reveal.outsideChat",
    open_failed: "chatWorkPanel.reveal.failed",
  },
} as const;

export type LocalResourceAction = keyof typeof RESOURCE_RESULT_KEYS;

export type ResolvedChatWorkPanelResourceFileResult =
  | { ok: true; path: string }
  | {
      ok: false;
      code: ChatWorkPanelLocalResourceErrorCode;
      message: string;
    };

function platformPathApi(platform: NodeJS.Platform | string, rootPath: string) {
  if (platform === "win32") {
    return path.posix.isAbsolute(rootPath) ? path.posix : path.win32;
  }
  return path.posix;
}

function fail(
  code: ChatWorkPanelLocalResourceErrorCode,
  message: string,
): ResolvedChatWorkPanelResourceFileResult {
  return { ok: false, code, message };
}

export function toChatWorkPanelLocalResourceActionResult(
  result: Pick<ChatWorkPanelOpenLocalResourceResult, "ok" | "code">,
  action: LocalResourceAction,
): ChatWorkPanelOpenLocalResourceResult {
  const messageKeys = RESOURCE_RESULT_KEYS[action];
  if (result.ok) {
    return { ok: true, message: t(messageKeys.success) };
  }
  const code = result.code && Object.prototype.hasOwnProperty.call(messageKeys, result.code)
    ? result.code
    : "open_failed";
  return { ok: false, code, message: t(messageKeys[code]) };
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
  if (
    parts.length < 2 ||
    parts[0] !== expectedRoot ||
    parts.some((part) => {
      if (part === "..") return true;
      try {
        let decoded = part;
        for (let depth = 0; depth < 4; depth += 1) {
          const next = decodeURIComponent(decoded);
          if (next === "." || next === ".." || next.includes("/") || next.includes("\\")) {
            return true;
          }
          if (next === decoded) return false;
          decoded = next;
        }
        return /%[\da-f]{2}/iu.test(decoded);
      } catch {
        return false;
      }
    })
  ) {
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

export function resolveChatWorkPanelResourceFile(
  request: ChatWorkPanelOpenLocalResourceRequest,
  dependencies: OpenChatResourceDependencies,
  action: LocalResourceAction,
): ResolvedChatWorkPanelResourceFileResult {
  const messageKeys = RESOURCE_RESULT_KEYS[action];
  const normalized = normalizeChatWorkPanelOpenLocalResourceRequest(request);
  if (!normalized) {
    return fail("invalid_request", t(messageKeys.invalid_request));
  }
  const platform = dependencies.platform ?? process.platform;
  if (platform === "win32" && normalized.relativePath.includes(":")) {
    return fail("invalid_request", t(messageKeys.invalid_request));
  }
  const runtimeRoot = (dependencies.resolveRuntimeRoot ?? resolvePreferredAgentPlatformRuntimeRoot)(
    dependencies.app,
  );
  const pathApi = platformPathApi(platform, runtimeRoot);
  const chatRoot = pathApi.resolve(pathApi.join(runtimeRoot, "chats", normalized.ownerChatId));
  const candidatePath = pathApi.resolve(pathApi.join(chatRoot, normalized.relativePath));
  if (!isInside(chatRoot, candidatePath, pathApi)) {
    return fail("path_outside_chat", t(messageKeys.path_outside_chat));
  }

  const existsSync = dependencies.existsSync ?? fs.existsSync;
  const realpathSync = dependencies.realpathSync ?? fs.realpathSync.native;
  const statSync = dependencies.statSync ?? fs.statSync;
  if (!existsSync(chatRoot) || !existsSync(candidatePath)) {
    return fail("not_found", t(messageKeys.not_found));
  }

  let realChatRoot = "";
  let realCandidatePath = "";
  try {
    realChatRoot = realpathSync(chatRoot);
    realCandidatePath = realpathSync(candidatePath);
  } catch {
    return fail("not_found", t(messageKeys.not_found));
  }
  if (!isInside(realChatRoot, realCandidatePath, pathApi)) {
    return fail("path_outside_chat", t(messageKeys.path_outside_chat));
  }
  if (!statSync(realCandidatePath).isFile()) {
    return fail("not_file", t(messageKeys.not_file));
  }

  return { ok: true, path: realCandidatePath };
}

export async function openChatWorkPanelResourceInDefaultApp(
  request: ChatWorkPanelOpenLocalResourceRequest,
  dependencies: OpenChatResourceDependencies,
): Promise<ChatWorkPanelOpenLocalResourceResult> {
  const resolved = resolveChatWorkPanelResourceFile(request, dependencies, "openDefault");
  if (!resolved.ok) {
    return toChatWorkPanelLocalResourceActionResult(resolved, "openDefault");
  }

  try {
    const openError = await (dependencies.openPath ?? electronShell.openPath)(resolved.path);
    return toChatWorkPanelLocalResourceActionResult(
      { ok: !openError, ...(openError ? { code: "open_failed" as const } : {}) },
      "openDefault",
    );
  } catch {
    return toChatWorkPanelLocalResourceActionResult(
      { ok: false, code: "open_failed" },
      "openDefault",
    );
  }
}

export async function revealChatWorkPanelResourceInFileManager(
  request: ChatWorkPanelOpenLocalResourceRequest,
  dependencies: OpenChatResourceDependencies,
): Promise<ChatWorkPanelOpenLocalResourceResult> {
  const resolved = resolveChatWorkPanelResourceFile(request, dependencies, "reveal");
  if (!resolved.ok) {
    return toChatWorkPanelLocalResourceActionResult(resolved, "reveal");
  }

  try {
    (dependencies.showItemInFolder ?? electronShell.showItemInFolder)(resolved.path);
    return toChatWorkPanelLocalResourceActionResult({ ok: true }, "reveal");
  } catch {
    return toChatWorkPanelLocalResourceActionResult(
      { ok: false, code: "open_failed" },
      "reveal",
    );
  }
}
