import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import type { App } from "electron";
import { resolveAssistantAttachmentPath } from "./attachment-store";
import {
  createImageDocumentMetadata,
  extractDocumentTextFromFile,
  renderPdfPagesForVision
} from "./document-extract";
import { loadAgentPlatformMinimaxSettings } from "./agent-platform-config";
import { readAssistantSettings } from "./settings-store";
import { canDescribeImageWithVision, describeImageWithVision } from "./vision-provider";
import type { AssistantAttachmentDocument } from "../../shared/contracts";
export {
  listHostStartupItems,
  removeHostStartupItems,
  type HostStartupEnvironment,
  type HostStartupItem,
  type HostStartupListResult,
  type HostStartupRemoveResult
} from "./host-startup-items";

export type DesktopFileEntry = {
  name: string;
  path: string;
  relativePath: string;
  kind: "file" | "directory";
  extension: string;
  sizeBytes: number;
  modifiedAt: string;
};

export type DesktopMoveOperation = {
  from: string;
  to: string;
};

export type DesktopOrganizePlan = {
  root: string;
  moves: DesktopMoveOperation[];
  skipped: string[];
};

export type DesktopDeleteResult = {
  deleted: string[];
};

export type DesktopDocumentReadResult = {
  path: string;
  sizeBytes: number;
  content: string;
  truncated: boolean;
  document: AssistantAttachmentDocument;
  error?: string;
};

export type HostCommandResult = {
  ok: boolean;
  command: string;
  cwd: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

const MAX_LIST_ENTRIES = 500;
const MAX_READ_BYTES = 1024 * 1024;
const MAX_DOCUMENT_READ_BYTES = 32 * 1024 * 1024;
const MAX_DOCUMENT_IMAGE_CONTEXT_BYTES = 10 * 1024 * 1024;
const MAX_COMMAND_BUFFER_BYTES = 512 * 1024;

const ORGANIZE_FOLDERS: Array<{ folder: string; extensions: string[] }> = [
  { folder: "Images", extensions: [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".heic"] },
  { folder: "Videos", extensions: [".mp4", ".mov", ".avi", ".mkv", ".webm"] },
  { folder: "Audio", extensions: [".mp3", ".wav", ".m4a", ".flac", ".aac"] },
  { folder: "Documents", extensions: [".txt", ".md", ".doc", ".docx", ".rtf"] },
  { folder: "PDFs", extensions: [".pdf"] },
  { folder: "Spreadsheets", extensions: [".csv", ".xls", ".xlsx", ".numbers"] },
  { folder: "Presentations", extensions: [".ppt", ".pptx", ".key"] },
  { folder: "Archives", extensions: [".zip", ".tar", ".gz", ".tgz", ".rar", ".7z"] },
  { folder: "Code", extensions: [".html", ".css", ".js", ".ts", ".tsx", ".json", ".xml", ".yaml", ".yml", ".py", ".go", ".java"] }
];

function isWindowsPlatform() {
  return process.platform === "win32";
}

function isMacPlatform() {
  return process.platform === "darwin";
}

function formatDesktopSizeLimit(sizeBytes: number) {
  return `${Math.round(sizeBytes / 1024 / 1024)}MB`;
}

function normalizeForCompare(value: string) {
  const resolved = path.resolve(value);
  return isWindowsPlatform() ? resolved.toLowerCase() : resolved;
}

function isInsideOrSame(parent: string, candidate: string) {
  const normalizedParent = normalizeForCompare(parent);
  const normalizedCandidate = normalizeForCompare(candidate);
  if (normalizedParent === normalizedCandidate) {
    return true;
  }
  const relative = path.relative(normalizedParent, normalizedCandidate);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function desktopRoot(app: App) {
  return path.resolve(app.getPath("desktop"));
}

function assistantRoot(app: App) {
  return path.resolve(path.join(app.getPath("userData"), "assistant"));
}

function chatWorkspaceRoot(app: App, chatId: string) {
  return path.resolve(path.join(assistantRoot(app), "chats", chatId, "workspace"));
}

export function getAllowedDesktopToolRoots(app: App, chatId?: string | null) {
  const roots = [desktopRoot(app), assistantRoot(app)];
  if (chatId) {
    roots.push(chatWorkspaceRoot(app, chatId));
  }
  return [...new Set(roots.map((root) => path.resolve(root)))];
}

export function resolveDesktopToolPath(app: App, inputPath: string | undefined, chatId?: string | null) {
  const desktop = desktopRoot(app);
  const trimmed = String(inputPath ?? "").trim();
  const candidate = trimmed
    ? path.isAbsolute(trimmed)
      ? trimmed
      : path.join(desktop, trimmed)
    : desktop;
  const resolved = path.resolve(candidate);
  const allowedRoots = getAllowedDesktopToolRoots(app, chatId);
  if (!allowedRoots.some((root) => isInsideOrSame(root, resolved))) {
    throw new Error(`路径不在允许范围内：${resolved}`);
  }
  return resolved;
}

function readStats(filePath: string) {
  const stat = fs.statSync(filePath);
  return {
    kind: stat.isDirectory() ? "directory" as const : "file" as const,
    sizeBytes: stat.size,
    modifiedAt: stat.mtime.toISOString()
  };
}

function listDirectoryEntries(root: string, current: string, recursive: boolean, entries: DesktopFileEntry[]) {
  if (entries.length >= MAX_LIST_ENTRIES) {
    return;
  }
  for (const dirent of fs.readdirSync(current, { withFileTypes: true })) {
    if (entries.length >= MAX_LIST_ENTRIES) {
      return;
    }
    if (dirent.name === ".DS_Store") {
      continue;
    }
    const filePath = path.join(current, dirent.name);
    const stats = readStats(filePath);
    entries.push({
      name: dirent.name,
      path: filePath,
      relativePath: path.relative(root, filePath) || dirent.name,
      extension: dirent.isDirectory() ? "" : path.extname(dirent.name).toLowerCase(),
      ...stats
    });
    if (recursive && dirent.isDirectory()) {
      listDirectoryEntries(root, filePath, recursive, entries);
    }
  }
}

export function listDesktopFiles(app: App, input: { path?: string; recursive?: boolean; maxEntries?: number }, chatId?: string | null) {
  const root = resolveDesktopToolPath(app, input.path, chatId);
  const entries: DesktopFileEntry[] = [];
  if (!fs.existsSync(root)) {
    throw new Error(`路径不存在：${root}`);
  }
  const stat = fs.statSync(root);
  if (!stat.isDirectory()) {
    const stats = readStats(root);
    return {
      root,
      entries: [{
        name: path.basename(root),
        path: root,
        relativePath: path.basename(root),
        extension: path.extname(root).toLowerCase(),
        ...stats
      }]
    };
  }
  listDirectoryEntries(root, root, Boolean(input.recursive), entries);
  return {
    root,
    entries: entries.slice(0, Math.min(Math.max(Number(input.maxEntries) || MAX_LIST_ENTRIES, 1), MAX_LIST_ENTRIES))
  };
}

export function readDesktopFile(app: App, input: { path?: string }, chatId?: string | null) {
  const filePath = resolveDesktopToolPath(app, input.path, chatId);
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) {
    throw new Error(`不是可读取文件：${filePath}`);
  }
  if (stat.size > MAX_READ_BYTES) {
    throw new Error(`文件超过 ${MAX_READ_BYTES} bytes，不能直接读取：${filePath}`);
  }
  return {
    path: filePath,
    sizeBytes: stat.size,
    content: fs.readFileSync(filePath, "utf8")
  };
}

function guessImageMimeType(filePath: string) {
  switch (path.extname(filePath).toLowerCase()) {
    case ".gif":
      return "image/gif";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    default:
      return "";
  }
}

function readVisionCapableSettings(app: App) {
  return loadAgentPlatformMinimaxSettings(app) ?? readAssistantSettings(app);
}

async function readImageDocumentWithVision(
  app: App,
  filePath: string,
  stat: fs.Stats,
  signal: AbortSignal
): Promise<DesktopDocumentReadResult | null> {
  const mimeType = guessImageMimeType(filePath);
  if (!mimeType) {
    return null;
  }
  if (stat.size > MAX_DOCUMENT_IMAGE_CONTEXT_BYTES) {
    const imageDocument = createImageDocumentMetadata({
      readable: false,
      error: `图片已保存，但超过 ${formatDesktopSizeLimit(MAX_DOCUMENT_IMAGE_CONTEXT_BYTES)}，未发送给 MiniMax 图片理解接口。`,
      errorCode: "image_too_large_for_vision"
    });
    return {
      path: filePath,
      sizeBytes: stat.size,
      content: "",
      truncated: false,
      document: imageDocument.document,
      error: imageDocument.error
    };
  }

  const buffer = fs.readFileSync(filePath);
  const dataUrl = `data:${mimeType};base64,${buffer.toString("base64")}`;
  const settings = readVisionCapableSettings(app);
  if (!canDescribeImageWithVision(settings, dataUrl)) {
    const imageDocument = createImageDocumentMetadata({
      readable: false,
      error: "当前 MiniMax 配置无法调用图片理解接口，无法理解图片内容。",
      errorCode: "vision_unavailable"
    });
    return {
      path: filePath,
      sizeBytes: stat.size,
      content: "",
      truncated: false,
      document: {
        ...imageDocument.document,
        visionStatus: "unavailable"
      },
      error: imageDocument.error
    };
  }

  const result = await describeImageWithVision({
    settings,
    name: path.basename(filePath),
    dataUrl,
    signal
  });
  const document: AssistantAttachmentDocument = {
    format: "image",
    readStatus: "readable",
    extractedChars: result.summary.length,
    truncated: false,
    imageMode: "vision",
    visionSummary: result.summary,
    visionStatus: "readable"
  };
  return {
    path: filePath,
    sizeBytes: stat.size,
    content: result.summary,
    truncated: false,
    document
  };
}

async function readScannedPdfWithVision(
  app: App,
  filePath: string,
  stat: fs.Stats,
  extracted: Awaited<ReturnType<typeof extractDocumentTextFromFile>>,
  signal: AbortSignal
): Promise<DesktopDocumentReadResult | null> {
  if (extracted.errorCode !== "scanned_pdf_no_text") {
    return null;
  }
  const pageImages = await renderPdfPagesForVision(filePath);
  const settings = readVisionCapableSettings(app);
  if (!pageImages.some((pageImage) => canDescribeImageWithVision(settings, pageImage.dataUrl))) {
    return null;
  }
  const summaries: string[] = [];
  for (const pageImage of pageImages) {
    if (!canDescribeImageWithVision(settings, pageImage.dataUrl)) {
      continue;
    }
    const result = await describeImageWithVision({
      settings,
      name: `${path.basename(filePath)} 第 ${pageImage.pageNumber} 页`,
      dataUrl: pageImage.dataUrl,
      signal
    });
    summaries.push(`Page ${pageImage.pageNumber}\n${result.summary}`);
  }
  const content = summaries.join("\n\n");
  if (!content.trim()) {
    return null;
  }
  return {
    path: filePath,
    sizeBytes: stat.size,
    content,
    truncated: false,
    document: {
      ...extracted.document,
      readStatus: "readable",
      extractedChars: content.length,
      visionSummary: content,
      visionStatus: "readable"
    }
  };
}

export async function readDesktopDocument(
  app: App,
  input: { path?: string; attachmentId?: string; pages?: string; sheet?: string; maxChars?: number },
  chatId?: string | null,
  options: { signal?: AbortSignal } = {}
): Promise<DesktopDocumentReadResult> {
  const attachmentId = String(input.attachmentId ?? "").trim();
  const filePath = attachmentId
    ? (() => {
        if (!chatId) {
          throw new Error("读取聊天附件需要当前 chatId。");
        }
        return resolveAssistantAttachmentPath(app, chatId, attachmentId);
      })()
    : resolveDesktopToolPath(app, input.path, chatId);
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) {
    throw new Error(`不是可读取文档：${filePath}`);
  }
  if (stat.size > MAX_DOCUMENT_READ_BYTES) {
    throw new Error(`文档超过 ${MAX_DOCUMENT_READ_BYTES} bytes，不能直接读取：${filePath}`);
  }
  const signal = options.signal ?? new AbortController().signal;
  const imageRead = await readImageDocumentWithVision(app, filePath, stat, signal);
  if (imageRead) {
    return imageRead;
  }
  const extracted = await extractDocumentTextFromFile(filePath, {
    maxChars: input.maxChars
  });
  const scannedPdfRead = await readScannedPdfWithVision(app, filePath, stat, extracted, signal);
  if (scannedPdfRead) {
    return scannedPdfRead;
  }
  return {
    path: filePath,
    sizeBytes: stat.size,
    content: extracted.text,
    truncated: extracted.truncated,
    document: extracted.document,
    ...(extracted.error ? { error: extracted.error } : {})
  };
}

export function writeDesktopFile(
  app: App,
  input: { path?: string; filename?: string; content?: string; overwrite?: boolean },
  chatId?: string | null
) {
  const targetInput = input.path || input.filename;
  if (!targetInput) {
    throw new Error("写入文件需要 path 或 filename。");
  }
  const filePath = resolveDesktopWriteFilePath(app, input, chatId);
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    throw new Error(`写入目标是目录，请提供文件名：${filePath}`);
  }
  const existedBefore = fs.existsSync(filePath);
  const finalPath = existedBefore && !input.overwrite ? uniqueDestination(filePath) : filePath;
  ensureDir(path.dirname(finalPath));
  fs.writeFileSync(finalPath, String(input.content ?? ""), "utf8");
  return {
    path: finalPath,
    requestedPath: filePath,
    sizeBytes: Buffer.byteLength(String(input.content ?? ""), "utf8"),
    overwritten: existedBefore && Boolean(input.overwrite),
    renamed: existedBefore && !input.overwrite
  };
}

function resolveDesktopWriteFilePath(
  app: App,
  input: { path?: string; filename?: string },
  chatId?: string | null
) {
  const rawPath = String(input.path ?? "").trim();
  const rawFilename = String(input.filename ?? "").trim();
  if (rawPath && rawFilename) {
    const resolvedPath = resolveDesktopToolPath(app, rawPath, chatId);
    const shouldJoinFilename = fs.existsSync(resolvedPath)
      ? fs.statSync(resolvedPath).isDirectory()
      : !path.extname(resolvedPath);
    return shouldJoinFilename
      ? resolveDesktopToolPath(app, path.join(resolvedPath, rawFilename), chatId)
      : resolvedPath;
  }
  return resolveDesktopToolPath(app, rawPath || rawFilename, chatId);
}

function folderForExtension(extension: string) {
  const lower = extension.toLowerCase();
  return ORGANIZE_FOLDERS.find((group) => group.extensions.includes(lower))?.folder ?? "Other";
}

export function planDesktopOrganize(app: App, input: { path?: string } = {}, chatId?: string | null): DesktopOrganizePlan {
  const root = resolveDesktopToolPath(app, input.path, chatId);
  if (!fs.statSync(root).isDirectory()) {
    throw new Error(`整理目标必须是目录：${root}`);
  }
  const skipped: string[] = [];
  const moves: DesktopMoveOperation[] = [];
  for (const dirent of fs.readdirSync(root, { withFileTypes: true })) {
    if (dirent.name.startsWith(".") || dirent.isDirectory()) {
      skipped.push(dirent.name);
      continue;
    }
    const source = path.join(root, dirent.name);
    const targetFolder = folderForExtension(path.extname(dirent.name));
    const target = path.join(root, targetFolder, dirent.name);
    if (normalizeForCompare(source) !== normalizeForCompare(target)) {
      moves.push({ from: source, to: target });
    }
  }
  return { root, moves, skipped };
}

function uniqueDestination(target: string) {
  if (!fs.existsSync(target)) {
    return target;
  }
  const dir = path.dirname(target);
  const ext = path.extname(target);
  const base = path.basename(target, ext);
  for (let index = 1; index < 1000; index += 1) {
    const candidate = path.join(dir, `${base} ${index}${ext}`);
    if (!fs.existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(`无法生成不冲突的目标文件名：${target}`);
}

export function moveDesktopFiles(app: App, input: { moves?: DesktopMoveOperation[] }, chatId?: string | null) {
  const moves = Array.isArray(input.moves) ? input.moves : [];
  if (moves.length === 0) {
    throw new Error("移动文件需要 moves 数组。");
  }
  const completed: DesktopMoveOperation[] = [];
  for (const move of moves) {
    const from = resolveDesktopToolPath(app, move.from, chatId);
    const to = uniqueDestination(resolveDesktopToolPath(app, move.to, chatId));
    ensureDir(path.dirname(to));
    fs.renameSync(from, to);
    completed.push({ from, to });
  }
  return { moved: completed };
}

export function deleteDesktopFiles(
  app: App,
  input: { paths?: string[] },
  chatId?: string | null
): DesktopDeleteResult {
  const paths = Array.isArray(input.paths) ? input.paths : [];
  if (paths.length === 0) {
    throw new Error("删除文件需要 paths 数组。");
  }
  const deleted: string[] = [];
  for (const item of paths) {
    const filePath = resolveDesktopToolPath(app, item, chatId);
    if (!fs.existsSync(filePath)) {
      continue;
    }
    fs.rmSync(filePath, { recursive: true, force: false });
    deleted.push(filePath);
  }
  return { deleted };
}

function commandShell() {
  if (isWindowsPlatform()) {
    return {
      file: "powershell.exe",
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command"],
      platform: "windows"
    };
  }
  if (isMacPlatform()) {
    return {
      file: "/bin/zsh",
      args: ["-lc"],
      platform: "mac"
    };
  }
  return {
    file: "/bin/sh",
    args: ["-lc"],
    platform: "unix"
  };
}

function isWindowsPlatformName(platform: string) {
  return platform === "win32" || platform === "windows";
}

function buildPortKillRecoveryCommand(command: string, stderr: string, platform: string = process.platform) {
  if (!/no such process|not a process|找不到|不存在/iu.test(stderr)) {
    return null;
  }
  const match = command.trim().match(/^kill\s+(-9\s+)?(\d{2,5})$/u);
  if (!match?.[2]) {
    return null;
  }
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    return null;
  }
  const force = Boolean(match[1]);
  if (isWindowsPlatformName(platform)) {
    return [
      `$pid = (Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess)`,
      "if ($pid) {",
      `  Stop-Process -Id $pid${force ? " -Force" : ""}`,
      "} else {",
      `  throw "No process is listening on port ${port}"`,
      "}"
    ].join("; ");
  }
  // macOS/Linux: when a bare numeric kill fails, treat common dev-server ports as ports and resolve the real PID.
  return [
    `pid="$(lsof -nP -tiTCP:${port} -sTCP:LISTEN | head -n 1)"`,
    "if [ -n \"$pid\" ]; then",
    `kill ${force ? "-9 " : ""}"$pid"`,
    "else",
    `echo "No process is listening on port ${port}" >&2; exit 1`,
    "fi"
  ].join("; ");
}

function execHostShellCommand(
  shell: ReturnType<typeof commandShell>,
  command: string,
  cwd: string,
  timeout: number
) {
  return new Promise<HostCommandResult>((resolve) => {
    execFile(shell.file, [...shell.args, command], {
      cwd,
      timeout,
      maxBuffer: MAX_COMMAND_BUFFER_BYTES,
      windowsHide: true
    }, (error, stdout, stderr) => {
      const exitCode = typeof (error as NodeJS.ErrnoException | null)?.code === "number"
        ? Number((error as NodeJS.ErrnoException).code)
        : error
          ? 1
          : 0;
      const timedOut = Boolean(error && "killed" in error && (error as { killed?: boolean }).killed);
      resolve({
        ok: !error,
        command,
        cwd,
        exitCode,
        stdout,
        stderr,
        timedOut
      });
    });
  });
}

export function runHostCommand(
  app: App,
  input: { command?: string; cwd?: string; timeoutMs?: number },
  chatId?: string | null
): Promise<HostCommandResult> {
  const command = String(input.command ?? "").trim();
  if (!command) {
    throw new Error("执行命令需要 command。");
  }
  const cwd = resolveDesktopToolPath(app, input.cwd || "", chatId);
  const shell = commandShell();
  const timeout = Math.min(Math.max(Number(input.timeoutMs) || 30000, 1000), 120000);

  return execHostShellCommand(shell, command, cwd, timeout).then(async (result) => {
    if (result.ok || result.timedOut) {
      return result;
    }
    const recoveryCommand = buildPortKillRecoveryCommand(command, result.stderr, shell.platform);
    if (!recoveryCommand) {
      return result;
    }
    const recovered = await execHostShellCommand(shell, recoveryCommand, cwd, timeout);
    return {
      ...recovered,
      command,
      stdout: [result.stdout, recovered.stdout].filter(Boolean).join("\n"),
      stderr: [result.stderr, recovered.stderr].filter(Boolean).join("\n")
    };
  });
}

export const __testInternals = {
  MAX_LIST_ENTRIES,
  MAX_READ_BYTES,
  MAX_DOCUMENT_READ_BYTES,
  folderForExtension,
  getAllowedDesktopToolRoots,
  isInsideOrSame,
  resolveDesktopToolPath,
  buildPortKillRecoveryCommand
};
