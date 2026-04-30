import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import type { App } from "electron";

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

export function writeDesktopFile(
  app: App,
  input: { path?: string; filename?: string; content?: string; overwrite?: boolean },
  chatId?: string | null
) {
  const targetInput = input.path || input.filename;
  if (!targetInput) {
    throw new Error("写入文件需要 path 或 filename。");
  }
  const filePath = resolveDesktopToolPath(app, targetInput, chatId);
  const existedBefore = fs.existsSync(filePath);
  if (existedBefore && !input.overwrite) {
    throw new Error(`文件已存在，请确认覆盖或换一个文件名：${filePath}`);
  }
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, String(input.content ?? ""), "utf8");
  return {
    path: filePath,
    sizeBytes: Buffer.byteLength(String(input.content ?? ""), "utf8"),
    overwritten: existedBefore
  };
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

  return new Promise((resolve) => {
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

export const __testInternals = {
  MAX_LIST_ENTRIES,
  MAX_READ_BYTES,
  folderForExtension,
  getAllowedDesktopToolRoots,
  isInsideOrSame,
  resolveDesktopToolPath
};
