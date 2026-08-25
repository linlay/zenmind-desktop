import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  net,
  session,
  shell,
  type BrowserWindow,
  type Session,
  type WebContents,
} from "electron";
import {
  CHAT_WORK_PANEL_LOCAL_FILE_PROTOCOL,
  createWorkPanelLocalFilePartition,
  type WorkPanelLocalFileClaimRequest,
  type WorkPanelLocalFileClaimResult,
  type WorkPanelLocalFileHandleRequest,
  type WorkPanelLocalFilePreviewKind,
  type WorkPanelLocalFileReleaseRequest,
  type WorkPanelLocalFileSelectRequest,
  type WorkPanelLocalFileSelection,
} from "../shared/chat-work-panel";
import { t } from "./i18n/main-i18n";

type LocalFileHandle = {
  handleId: string;
  ownerChatId: string;
  rendererGeneration: string;
  rendererWebContentsId: number;
  filePath: string;
  fileName: string;
  rootRealPath: string;
  previewKind: WorkPanelLocalFilePreviewKind;
  partition: string;
  session: Session;
};

type PendingLocalFileClaim = {
  claimId: string;
  ownerChatId: string;
  rendererWebContentsId: number;
  filePath: string;
  expiresAt: number;
  timeout: ReturnType<typeof setTimeout>;
};

type WorkPanelLocalFileRegistryOptions = {
  claimTtlMs?: number;
  now?: () => number;
  randomUUID?: () => string;
  createSession?: (partition: string) => Session;
  fetchFile?: (url: string) => Promise<Response>;
  schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearScheduled?: (timeout: ReturnType<typeof setTimeout>) => void;
};

type ProtocolModule = {
  registerSchemesAsPrivileged(schemes: Array<{
    scheme: string;
    privileges: {
      standard: boolean;
      secure: boolean;
      supportFetchAPI: boolean;
      corsEnabled: boolean;
      stream: boolean;
    };
  }>): void;
};

const PREVIEW_EXTENSIONS: Record<Exclude<WorkPanelLocalFilePreviewKind, "unsupported">, Set<string>> = {
  html: new Set([".html", ".htm", ".xhtml"]),
  pdf: new Set([".pdf"]),
  image: new Set([".avif", ".bmp", ".gif", ".ico", ".jpeg", ".jpg", ".png", ".svg", ".webp"]),
  text: new Set([
    ".c", ".cc", ".cpp", ".css", ".csv", ".go", ".h", ".hpp", ".ini", ".java", ".js", ".json",
    ".jsx", ".log", ".md", ".mjs", ".py", ".rs", ".sh", ".sql", ".toml", ".ts", ".tsx", ".txt",
    ".xml", ".yaml", ".yml",
  ]),
  audio: new Set([".aac", ".flac", ".m4a", ".mp3", ".oga", ".ogg", ".wav"]),
  video: new Set([".m4v", ".mov", ".mp4", ".ogv", ".webm"]),
};

export const WORK_PANEL_LOCAL_FILE_CLAIM_TTL_MS = 30_000;

const BLOCKED_LOCAL_FILE_REQUEST_PATTERNS = [
  "http://*/*",
  "https://*/*",
  "ws://*/*",
  "wss://*/*",
  "ftp://*/*",
];

function cleanIdentity(value: unknown, max = 512) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized && normalized.length <= max ? normalized : "";
}

export function classifyWorkPanelLocalFile(fileName: string): WorkPanelLocalFilePreviewKind {
  const extension = path.extname(fileName).toLowerCase();
  for (const [kind, extensions] of Object.entries(PREVIEW_EXTENSIONS)) {
    if (extensions.has(extension)) return kind as WorkPanelLocalFilePreviewKind;
  }
  return "unsupported";
}

export function isPathInsideLocalFileRoot(rootPath: string, targetPath: string, platform = process.platform) {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const relativePath = pathApi.relative(rootPath, targetPath);
  return Boolean(relativePath && !relativePath.startsWith("..") && !pathApi.isAbsolute(relativePath));
}

export function normalizeWorkPanelLocalFileRelativePath(value: unknown) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (
    !raw ||
    raw.length > 2_048 ||
    /[\u0000-\u001f\u007f]/u.test(raw) ||
    /^[a-z][a-z\d+.-]*:/iu.test(raw) ||
    raw.startsWith("/") ||
    raw.startsWith("\\") ||
    /^[a-z]:[\\/]/iu.test(raw)
  ) {
    return "";
  }
  const parts = raw.replace(/\\/gu, "/").split("/").filter((part) => part && part !== ".");
  return parts.length > 0 && parts.every((part) => part !== "..") ? parts.join("/") : "";
}

export type WorkPanelLocalFilePathResolution =
  | { ok: true; filePath: string }
  | {
      ok: false;
      code: "invalid_path" | "workspace_unavailable" | "path_outside_workspace" | "file_unavailable";
      message: string;
    };

export function resolveWorkPanelLocalFileFromWorkspace(
  workspaceDir: string,
  requestedPath: unknown,
  platform = process.platform,
): WorkPanelLocalFilePathResolution {
  const relativePath = normalizeWorkPanelLocalFileRelativePath(requestedPath);
  if (!relativePath) {
    return { ok: false, code: "invalid_path", message: "path must be a workspace-relative file path." };
  }
  let workspaceRealPath = "";
  try {
    workspaceRealPath = fs.realpathSync.native(workspaceDir);
    if (!fs.statSync(workspaceRealPath).isDirectory()) throw new Error("not a directory");
  } catch {
    return { ok: false, code: "workspace_unavailable", message: "The Agent workspace is unavailable on this Desktop." };
  }
  const candidatePath = path.resolve(workspaceRealPath, ...relativePath.split("/"));
  let filePath = "";
  try {
    filePath = fs.realpathSync.native(candidatePath);
  } catch {
    return { ok: false, code: "file_unavailable", message: "The requested local file is unavailable." };
  }
  if (!isPathInsideLocalFileRoot(workspaceRealPath, filePath, platform)) {
    return { ok: false, code: "path_outside_workspace", message: "The requested local file is outside the Agent workspace." };
  }
  try {
    if (!fs.statSync(filePath).isFile()) {
      return { ok: false, code: "file_unavailable", message: "The requested local path is not a regular file." };
    }
  } catch {
    return { ok: false, code: "file_unavailable", message: "The requested local file is unavailable." };
  }
  return { ok: true, filePath };
}

export function resolveLocalFileProtocolPath(handle: Pick<LocalFileHandle, "handleId" | "rootRealPath">, requestUrl: string) {
  let parsed: URL;
  try {
    parsed = new URL(requestUrl);
  } catch {
    return "";
  }
  let requestHandleId = "";
  let decodedPath = "";
  try {
    requestHandleId = decodeURIComponent(parsed.hostname);
    decodedPath = decodeURIComponent(parsed.pathname);
  } catch {
    return "";
  }
  if (
    parsed.protocol !== `${CHAT_WORK_PANEL_LOCAL_FILE_PROTOCOL}:` ||
    requestHandleId !== handle.handleId ||
    decodedPath.includes("\0")
  ) {
    return "";
  }
  const requestParts = decodedPath.split("/").filter(Boolean);
  if (requestParts.length === 0 || requestParts.some((part) => part === "." || part === "..")) return "";
  const candidatePath = path.resolve(handle.rootRealPath, ...requestParts);
  let candidateRealPath = "";
  try {
    candidateRealPath = fs.realpathSync.native(candidatePath);
  } catch {
    return "";
  }
  if (!isPathInsideLocalFileRoot(handle.rootRealPath, candidateRealPath)) return "";
  try {
    return fs.statSync(candidateRealPath).isFile() ? candidateRealPath : "";
  } catch {
    return "";
  }
}

export function registerChatWorkPanelLocalFileProtocolScheme(protocolModule: ProtocolModule) {
  protocolModule.registerSchemesAsPrivileged([{
    scheme: CHAT_WORK_PANEL_LOCAL_FILE_PROTOCOL,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  }]);
}

export class WorkPanelLocalFileRegistry {
  private readonly handles = new Map<string, LocalFileHandle>();
  private readonly pendingClaims = new Map<string, PendingLocalFileClaim>();
  private readonly observedSenders = new Set<number>();

  private readonly claimTtlMs: number;
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly createSession: (partition: string) => Session;
  private readonly fetchFile: (url: string) => Promise<Response>;
  private readonly schedule: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  private readonly clearScheduled: (timeout: ReturnType<typeof setTimeout>) => void;

  constructor(options: WorkPanelLocalFileRegistryOptions = {}) {
    this.claimTtlMs = options.claimTtlMs ?? WORK_PANEL_LOCAL_FILE_CLAIM_TTL_MS;
    this.now = options.now ?? Date.now;
    this.createId = options.randomUUID ?? crypto.randomUUID;
    this.createSession = options.createSession ?? ((partition) => session.fromPartition(partition, { cache: false }));
    this.fetchFile = options.fetchFile ?? ((url) => net.fetch(url));
    this.schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearScheduled = options.clearScheduled ?? clearTimeout;
  }

  private ownedHandle(request: WorkPanelLocalFileHandleRequest, sender: WebContents) {
    const handle = this.handles.get(cleanIdentity(request?.handleId, 256));
    return handle &&
      handle.ownerChatId === cleanIdentity(request?.ownerChatId) &&
      handle.rendererGeneration === cleanIdentity(request?.rendererGeneration) &&
      handle.rendererWebContentsId === sender.id
      ? handle
      : null;
  }

  private observeSender(sender: WebContents) {
    if (this.observedSenders.has(sender.id)) return;
    this.observedSenders.add(sender.id);
    sender.once("destroyed", () => {
      this.releaseWhere((handle) => handle.rendererWebContentsId === sender.id);
      this.discardClaimsWhere((claim) => claim.rendererWebContentsId === sender.id);
      this.observedSenders.delete(sender.id);
    });
  }

  private discardClaim(claim: PendingLocalFileClaim) {
    if (this.pendingClaims.get(claim.claimId) !== claim) return;
    this.pendingClaims.delete(claim.claimId);
    this.clearScheduled(claim.timeout);
  }

  private discardClaimsWhere(predicate: (claim: PendingLocalFileClaim) => boolean) {
    for (const claim of this.pendingClaims.values()) {
      if (predicate(claim)) this.discardClaim(claim);
    }
  }

  prepareClaim(input: {
    ownerChatId: string;
    rendererWebContentsId: number;
    filePath: string;
  }) {
    const ownerChatId = cleanIdentity(input.ownerChatId);
    const rendererWebContentsId = Number.isSafeInteger(input.rendererWebContentsId) && input.rendererWebContentsId > 0
      ? input.rendererWebContentsId
      : 0;
    let filePath = "";
    try {
      filePath = fs.realpathSync.native(input.filePath);
      if (!fs.statSync(filePath).isFile()) throw new Error("not a file");
    } catch {
      return null;
    }
    if (!ownerChatId || !rendererWebContentsId) return null;
    const claimId = this.createId();
    const expiresAt = this.now() + this.claimTtlMs;
    const claim = {
      claimId,
      ownerChatId,
      rendererWebContentsId,
      filePath,
      expiresAt,
      timeout: undefined as unknown as ReturnType<typeof setTimeout>,
    } satisfies PendingLocalFileClaim;
    claim.timeout = this.schedule(() => this.discardClaim(claim), this.claimTtlMs);
    claim.timeout.unref?.();
    this.pendingClaims.set(claimId, claim);
    return { claimId };
  }

  discardPreparedClaim(claimIdValue: string) {
    const claim = this.pendingClaims.get(cleanIdentity(claimIdValue, 256));
    if (!claim) return false;
    this.discardClaim(claim);
    return true;
  }

  private releaseHandle(handle: LocalFileHandle) {
    this.handles.delete(handle.handleId);
    try {
      handle.session.protocol.unhandle(CHAT_WORK_PANEL_LOCAL_FILE_PROTOCOL);
    } catch {
      // The temporary session may already have been disposed by Electron.
    }
    void handle.session.clearStorageData().catch(() => undefined);
    void handle.session.clearCache().catch(() => undefined);
  }

  private releaseWhere(predicate: (handle: LocalFileHandle) => boolean) {
    for (const handle of this.handles.values()) {
      if (predicate(handle)) this.releaseHandle(handle);
    }
  }

  private async createOrReuseHandle(
    filePathValue: string,
    ownerChatId: string,
    rendererGeneration: string,
    sender: WebContents,
  ): Promise<{ file: WorkPanelLocalFileSelection; reused: boolean } | null> {
    let filePath = "";
    try {
      filePath = fs.realpathSync.native(filePathValue);
      if (!fs.statSync(filePath).isFile()) return null;
    } catch {
      return null;
    }
    const existing = [...this.handles.values()].find((handle) =>
      handle.ownerChatId === ownerChatId &&
      handle.rendererGeneration === rendererGeneration &&
      handle.rendererWebContentsId === sender.id &&
      handle.filePath === filePath,
    );
    if (existing) {
      return {
        file: {
          handleId: existing.handleId,
          fileName: existing.fileName,
          previewKind: existing.previewKind,
        },
        reused: true,
      };
    }
    const rootRealPath = fs.realpathSync.native(path.dirname(filePath));
    const fileName = path.basename(filePath);
    const handleId = this.createId();
    const partition = createWorkPanelLocalFilePartition(handleId);
    const targetSession = this.createSession(partition);
    targetSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    targetSession.setPermissionCheckHandler?.(() => false);
    targetSession.webRequest.onBeforeRequest(
      { urls: BLOCKED_LOCAL_FILE_REQUEST_PATTERNS },
      (_details, callback) => callback({ cancel: true }),
    );
    const handle: LocalFileHandle = {
      handleId,
      ownerChatId,
      rendererGeneration,
      rendererWebContentsId: sender.id,
      filePath,
      fileName,
      rootRealPath,
      previewKind: classifyWorkPanelLocalFile(fileName),
      partition,
      session: targetSession,
    };
    await targetSession.protocol.handle(CHAT_WORK_PANEL_LOCAL_FILE_PROTOCOL, async (protocolRequest) => {
      const resolvedPath = resolveLocalFileProtocolPath(handle, protocolRequest.url);
      return resolvedPath
        ? this.fetchFile(pathToFileURL(resolvedPath).toString())
        : new Response("Not found", { status: 404 });
    });
    this.handles.set(handleId, handle);
    return {
      file: { handleId, fileName, previewKind: handle.previewKind },
      reused: false,
    };
  }

  async select(
    request: WorkPanelLocalFileSelectRequest,
    sender: WebContents,
    showFileDialog: (options: Electron.OpenDialogOptions, owner?: BrowserWindow | null) => Promise<Electron.OpenDialogReturnValue>,
    ownerWindow: BrowserWindow | null,
  ) {
    const ownerChatId = cleanIdentity(request?.ownerChatId);
    const rendererGeneration = cleanIdentity(request?.rendererGeneration);
    if (!ownerChatId || !rendererGeneration) {
      return { ok: false, files: [], message: "Invalid local file owner." };
    }
    const commonOptions: Electron.OpenDialogOptions = {
      properties: ["openFile", "multiSelections"],
    };
    const options = process.platform === "darwin"
      ? { ...commonOptions, title: t("dialog.workPanelLocalFiles.title") }
      : process.platform === "win32"
        ? { ...commonOptions, title: t("dialog.workPanelLocalFiles.title") }
        : commonOptions;
    const result = await showFileDialog(options, ownerWindow);
    if (result.canceled || result.filePaths.length === 0) return { ok: false, files: [] };
    this.observeSender(sender);
    const selections: WorkPanelLocalFileSelection[] = [];
    for (const selectedPath of result.filePaths) {
      try {
        const prepared = await this.createOrReuseHandle(
          selectedPath,
          ownerChatId,
          rendererGeneration,
          sender,
        );
        if (prepared) selections.push(prepared.file);
      } catch {
        // Ignore paths that disappear or become unreadable after the native picker closes.
      }
    }
    return { ok: selections.length > 0, files: selections };
  }

  async claim(
    request: WorkPanelLocalFileClaimRequest,
    sender: WebContents,
  ): Promise<WorkPanelLocalFileClaimResult> {
    const claimId = cleanIdentity(request?.claimId, 256);
    const ownerChatId = cleanIdentity(request?.ownerChatId);
    const rendererGeneration = cleanIdentity(request?.rendererGeneration);
    const claim = this.pendingClaims.get(claimId);
    if (
      !claim ||
      claim.expiresAt <= this.now() ||
      !ownerChatId ||
      !rendererGeneration ||
      claim.ownerChatId !== ownerChatId ||
      claim.rendererWebContentsId !== sender.id
    ) {
      if (claim && claim.expiresAt <= this.now()) this.discardClaim(claim);
      return { ok: false, message: "Local file claim is unavailable." };
    }
    this.discardClaim(claim);
    this.observeSender(sender);
    const prepared = await this.createOrReuseHandle(
      claim.filePath,
      ownerChatId,
      rendererGeneration,
      sender,
    );
    return prepared
      ? { ok: true, file: prepared.file, reused: prepared.reused }
      : { ok: false, message: "Local file is unavailable." };
  }

  release(request: WorkPanelLocalFileReleaseRequest, sender: WebContents) {
    const handleIds = new Set(Array.isArray(request?.handleIds) ? request.handleIds.map((id) => cleanIdentity(id, 256)) : []);
    this.releaseWhere((handle) => handleIds.has(handle.handleId) && Boolean(this.ownedHandle({ ...request, handleId: handle.handleId }, sender)));
    return { ok: true };
  }

  async open(request: WorkPanelLocalFileHandleRequest, sender: WebContents) {
    const handle = this.ownedHandle(request, sender);
    if (!handle) return { ok: false, message: "Local file handle is unavailable." };
    let error = "";
    if (process.platform === "darwin") error = await shell.openPath(handle.filePath);
    else if (process.platform === "win32") error = await shell.openPath(handle.filePath);
    else error = await shell.openPath(handle.filePath);
    return error ? { ok: false, message: error } : { ok: true };
  }

  reveal(request: WorkPanelLocalFileHandleRequest, sender: WebContents) {
    const handle = this.ownedHandle(request, sender);
    if (!handle) return { ok: false, message: "Local file handle is unavailable." };
    // Electron maps this call to Finder on macOS and Explorer on Windows.
    if (process.platform === "darwin") shell.showItemInFolder(handle.filePath);
    else if (process.platform === "win32") shell.showItemInFolder(handle.filePath);
    else shell.showItemInFolder(handle.filePath);
    return { ok: true };
  }
}

export const workPanelLocalFileRegistry = new WorkPanelLocalFileRegistry();

export function registerChatWorkPanelLocalFileIpcHandlers(
  ipcMain: Electron.IpcMain,
  options: {
    getMainWindow: () => BrowserWindow | null;
    showFileDialog: (options: Electron.OpenDialogOptions, owner?: BrowserWindow | null) => Promise<Electron.OpenDialogReturnValue>;
  },
) {
  const isMainRenderer = (sender: WebContents) => {
    const mainWindow = options.getMainWindow();
    return Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.id === sender.id);
  };
  ipcMain.handle("chatWorkPanel.localFiles.select", async (event, request: WorkPanelLocalFileSelectRequest) => {
    if (!isMainRenderer(event.sender)) return { ok: false, files: [], message: "Unauthorized renderer." };
    return workPanelLocalFileRegistry.select(request, event.sender, options.showFileDialog, options.getMainWindow());
  });
  ipcMain.handle("chatWorkPanel.localFiles.claim", async (event, request: WorkPanelLocalFileClaimRequest) => {
    if (!isMainRenderer(event.sender)) return { ok: false, message: "Unauthorized renderer." };
    return workPanelLocalFileRegistry.claim(request, event.sender);
  });
  ipcMain.handle("chatWorkPanel.localFiles.release", async (event, request: WorkPanelLocalFileReleaseRequest) => {
    if (!isMainRenderer(event.sender)) return { ok: false, message: "Unauthorized renderer." };
    return workPanelLocalFileRegistry.release(request, event.sender);
  });
  ipcMain.handle("chatWorkPanel.localFiles.open", async (event, request: WorkPanelLocalFileHandleRequest) => {
    if (!isMainRenderer(event.sender)) return { ok: false, message: "Unauthorized renderer." };
    return workPanelLocalFileRegistry.open(request, event.sender);
  });
  ipcMain.handle("chatWorkPanel.localFiles.reveal", async (event, request: WorkPanelLocalFileHandleRequest) => {
    if (!isMainRenderer(event.sender)) return { ok: false, message: "Unauthorized renderer." };
    return workPanelLocalFileRegistry.reveal(request, event.sender);
  });
}
