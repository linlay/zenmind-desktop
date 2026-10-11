import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { shell, type BrowserWindow, type IpcMain, type IpcMainInvokeEvent, type WebContents, type WebFrameMain } from "electron";
import {
  isSupportedDesktopDocumentPath,
  isLocalDocumentNewChat,
  localDocumentOwnerKey,
  LOCAL_DOCUMENT_CHANNELS,
  type LocalDocumentActionResult,
  type LocalDocumentBindResult,
  type LocalDocumentItem,
  type LocalDocumentWorkspaceState,
} from "../../../shared/local-document";
import { LocalDocumentPreview, type LocalDocumentPreviewDependencies } from "./local-document-preview";
import { LOCAL_MARKDOWN_MAX_BYTES } from "./local-document-worker-contract";
import { t } from "../../support/i18n/main-i18n";
import { resolveWorkPanelBrowserShortcut, WORK_PANEL_BROWSER_SHORTCUT_CHANNEL } from "../../../shared/work-panel-browser";
import { createAgentWebclientAgentPath } from "../../../shared/agent-webclient-routes";

type EditingChat = { agentKey: string; chatId: string; newChat?: string };
type DraftChatPromotion = { ownerWebContentsId: number; agentKey: string; newChat: string; chatId: string };
/** Main-only tool metadata. Absolute paths must never enter the preview DTO. */
export type LocalDocumentActiveFile = {
  fileName: string;
  kind: LocalDocumentItem["kind"];
  path: string;
  mimeType: "text/html" | "text/markdown";
  sizeBytes: number;
};
type FileChangeListener = (current: fs.Stats, previous: fs.Stats) => void;
type DocumentBinding = {
  owner: WebContents;
  frame: WebFrameMain;
  lifecycleGeneration: number;
  rendererGeneration: string;
  boundOwnerKey: string;
};

type DocumentEntry = {
  documentId: string;
  filePath: string;
  fileName: string;
  kind: LocalDocumentItem["kind"];
  ownerChatId: string;
  newChat?: string;
  agentKey: string;
  version: number;
  fileRevision: string;
  preview: LocalDocumentPreview;
  binding?: DocumentBinding;
  draftScope?: Pick<DocumentBinding, "owner" | "frame" | "lifecycleGeneration">;
  promotionPending?: boolean;
  pendingCanonicalChatId?: string;
  stopWatching?: () => void;
  guest?: WebContents;
};

type WorkspaceOptions = {
  getMainWindow(): BrowserWindow | null;
  showMainWindow(route?: string): void;
  getEditingChat(): Promise<EditingChat>;
  isEditingChatActive(chatId: string, agentKey: string, newChat?: string): boolean;
  isEditingChatRequested?(chatId: string, agentKey: string, newChat?: string): boolean;
  waitForEditingChatRequested?(chatId: string, agentKey: string, newChat?: string): Promise<boolean>;
  showFileDialog(options: Electron.OpenDialogOptions, owner?: BrowserWindow | null): Promise<Electron.OpenDialogReturnValue>;
  platform?: NodeJS.Platform;
};

type WorkspaceDependencies = LocalDocumentPreviewDependencies & {
  revealFile?: (filePath: string) => void;
  watchFile?: (filePath: string, options: { interval: number; persistent: boolean }, listener: FileChangeListener) => void;
  unwatchFile?: (filePath: string, listener: FileChangeListener) => void;
};

function fileRevision(stat: fs.Stats) {
  return `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.nlink}:${stat.isFile()}`;
}

function requestText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 512;
}

/** Originals begin as local drafts and adopt the Chat created by the first query. */
export class LocalDocumentWorkspaceController {
  private readonly documents = new Map<string, DocumentEntry>();
  private activeDocumentId: string | null = null;
  private revision = 0;
  private openRevision = 0;
  private rendererGeneration = 0;
  private disposed = false;
  private owner?: WebContents;
  private unobserveOwner?: () => void;
  private removeIpc?: () => void;
  private openQueue: Promise<void> = Promise.resolve();
  private readonly presentationWaiters = new Set<{
    chatId: string; agentKey: string; owner: WebContents; frame: WebFrameMain; generation: number;
    resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout>;
  }>();
  private readonly platform: NodeJS.Platform;

  constructor(private readonly options: WorkspaceOptions, private readonly dependencies: WorkspaceDependencies = {}) {
    this.platform = options.platform ?? process.platform;
  }

  async open(filePathValue: string, canOpen: () => boolean = () => true): Promise<void> {
    if (this.disposed || !canOpen()) return;
    const owner = this.mainContents();
    const frame = owner?.mainFrame;
    const generation = this.rendererGeneration;
    const isCurrent = () => !this.disposed && canOpen() && this.rendererGeneration === generation &&
      (!owner || (this.mainContents() === owner && owner.mainFrame === frame));
    // Finder events and direct callers can overlap. Keep their selection order
    // while allowing the next valid file to proceed after an individual error.
    const opening = this.openQueue.then(() => this.openDocument(filePathValue, isCurrent));
    this.openQueue = opening.catch(() => {});
    await opening;
  }

  private async openDocument(filePathValue: string, isCurrent: () => boolean): Promise<void> {
    if (!isCurrent()) return;
    if (!isSupportedDesktopDocumentPath(filePathValue)) throw new Error(t("dialog.localDocument.unsupported"));
    const filePath = await fs.promises.realpath(filePathValue);
    let stat = await fs.promises.stat(filePath);
    const fileName = path.basename(filePathValue);
    const kind = /\.(md|markdown)$/iu.test(fileName) ? "markdown" : "html";
    const validateFile = () => {
      if (!stat.isFile()) throw new Error(t("dialog.localDocument.readFailed"));
      if (kind === "markdown" && stat.size > LOCAL_MARKDOWN_MAX_BYTES) throw new Error(t("dialog.localDocument.tooLarge"));
    };
    validateFile();
    if (!isCurrent()) return;

    let reusedChat = this.reusableEditingChat();
    const reusedAnchor = reusedChat && [...this.documents.values()].find(entry => this.matchesConversation(entry, reusedChat!));
    let chat = reusedChat ?? await this.prepareEditingChat();
    const existing = reusedChat && [...this.documents.values()].find(entry =>
      this.samePath(entry.filePath, filePath) && this.matchesConversation(entry, reusedChat!));
    if (existing && isCurrent()) {
      this.activeDocumentId = existing.documentId;
      this.openRevision += 1;
      this.publish();
      this.showDocumentChat(existing);
      return;
    }
    if (!isCurrent()) return;
    const canonical = await fs.promises.realpath(filePath);
    stat = await fs.promises.stat(canonical);
    if (!isCurrent()) return;
    if (!this.samePath(canonical, filePath)) throw new Error(t("dialog.localDocument.readFailed"));
    validateFile();
    if (reusedChat?.newChat && reusedAnchor && this.documents.get(reusedAnchor.documentId) === reusedAnchor &&
        reusedAnchor.ownerChatId && !reusedAnchor.newChat) {
      const promoted = {chatId: reusedAnchor.ownerChatId, agentKey: reusedAnchor.agentKey};
      if (this.canReuseEditingChat(promoted)) { reusedChat = promoted; chat = promoted; }
    }
    if (reusedChat && !this.canReuseEditingChat(reusedChat)) {
      // The user may leave that Chat or close its last file during validation.
      // A fresh prepared owner keeps this explicit file open isolated.
      reusedChat = undefined;
      chat = await this.prepareEditingChat();
      if (!isCurrent()) return;
      const currentPath = await fs.promises.realpath(filePath);
      stat = await fs.promises.stat(currentPath);
      if (!isCurrent()) return;
      if (!this.samePath(currentPath, filePath)) throw new Error(t("dialog.localDocument.readFailed"));
      validateFile();
    }
    const document = { documentId: randomUUID(), filePath, fileName, kind } as const;
    const pendingCanonicalChatId = [...this.documents.values()].find(entry =>
      this.matchesConversation(entry, chat) && entry.pendingCanonicalChatId)?.pendingCanonicalChatId;
    const entry: DocumentEntry = {
      ...document, ownerChatId: chat.chatId, agentKey: chat.agentKey,
      ...(chat.newChat === undefined ? {} : { newChat: chat.newChat }),
      ...(pendingCanonicalChatId ? {pendingCanonicalChatId} : {}),
      ...(chat.chatId && [...this.documents.values()].some(entry => this.matchesConversation(entry, chat) && entry.promotionPending)
        ? {promotionPending: true} : {}),
      version: 0, fileRevision: fileRevision(stat),
      preview: new LocalDocumentPreview(document, this.dependencies),
    };
    this.documents.set(entry.documentId, entry);
    try { this.watchEntry(entry); }
    catch (error) { this.documents.delete(entry.documentId); this.releaseEntry(entry); throw error; }
    this.activeDocumentId = entry.documentId;
    this.openRevision += 1;
    this.publish();
    this.showDocumentChat(entry);
    if (entry.newChat) {
      const owner = this.mainContents();
      if (owner) entry.draftScope = { owner, frame: owner.mainFrame, lifecycleGeneration: this.rendererGeneration };
    }
    // Let a cold Main navigation settle before the next queued OS selection.
    // Waiting grants no binding authority and cannot undo an already-open file.
    try { await this.options.waitForEditingChatRequested?.(entry.ownerChatId, entry.agentKey, entry.newChat); }
    catch { /* A following open still requires its own live route proof. */ }
  }

  private canReuseEditingChat(chat: EditingChat) {
    const entries = [...this.documents.values()];
    return entries.some(entry => this.matchesConversation(entry, chat)) &&
      (this.options.isEditingChatActive(chat.chatId, chat.agentKey, chat.newChat) ||
        this.options.isEditingChatRequested?.(chat.chatId, chat.agentKey, chat.newChat) === true);
  }

  private matchesConversation(entry: DocumentEntry, chat: EditingChat) {
    return entry.ownerChatId === chat.chatId && entry.agentKey === chat.agentKey && entry.newChat === chat.newChat;
  }

  private reusableEditingChat(): EditingChat | undefined {
    const entries = [...this.documents.values()];
    // A just-requested Main navigation takes precedence over an older surface
    // whose canonical registration has not yet been replaced.
    for (const requested of [true, false]) {
      for (const entry of entries) {
        const matches = requested
          ? this.options.isEditingChatRequested?.(entry.ownerChatId, entry.agentKey, entry.newChat) === true
          : this.options.isEditingChatActive(entry.ownerChatId, entry.agentKey, entry.newChat);
        if (matches) return { chatId: entry.ownerChatId, agentKey: entry.agentKey, ...(entry.newChat ? { newChat: entry.newChat } : {}) };
      }
    }
  }

  private async prepareEditingChat() {
    try {
      const chat = await this.options.getEditingChat();
      if (!chat || !requestText(chat.agentKey) ||
        !(requestText(chat.chatId) && chat.newChat === undefined || chat.chatId === "" && isLocalDocumentNewChat(chat.newChat))) {
        throw new Error("Invalid local file conversation");
      }
      return chat;
    } catch { throw new Error(t("dialog.localDocument.editingChatFailed")); }
  }

  private samePath(left: string, right: string) {
    if (this.platform === "win32") return left.toLowerCase() === right.toLowerCase();
    return left === right;
  }

  private showDocumentChat(entry: DocumentEntry) {
    this.options.showMainWindow(createAgentWebclientAgentPath(entry.agentKey,
      new URLSearchParams(entry.newChat ? { newChat: entry.newChat } : { chatId: entry.ownerChatId })));
  }

  private draftPromotionEntries(input: DraftChatPromotion) {
    return [...this.documents.values()].filter(entry => !entry.ownerChatId &&
      entry.agentKey === input.agentKey && entry.newChat === input.newChat);
  }

  private requireDraftPromotionScope(input: DraftChatPromotion, entries: DocumentEntry[], committing: boolean) {
    const owner = this.mainContents();
    if (!owner || owner.id !== input.ownerWebContentsId || !requestText(input.agentKey) ||
        !requestText(input.chatId) || !isLocalDocumentNewChat(input.newChat)) throw new Error(t("dialog.localDocument.readFailed"));
    const canonicalRoute = this.options.isEditingChatRequested?.(input.chatId, input.agentKey) ??
      this.options.isEditingChatActive(input.chatId, input.agentKey);
    const draftRoute = this.options.isEditingChatRequested?.("", input.agentKey, input.newChat) ??
      this.options.isEditingChatActive("", input.agentKey, input.newChat);
    if (!(committing ? canonicalRoute : canonicalRoute || draftRoute) || entries.some(entry => !entry.draftScope ||
        entry.draftScope.owner !== owner || entry.draftScope.frame !== owner.mainFrame ||
        entry.draftScope.lifecycleGeneration !== this.rendererGeneration ||
        committing && entry.pendingCanonicalChatId !== input.chatId ||
        entry.pendingCanonicalChatId !== undefined && entry.pendingCanonicalChatId !== input.chatId)) {
      throw new Error(t("dialog.localDocument.readFailed"));
    }
  }

  /** Associate trusted chat.start before awaiting the canonical-sync ACK. */
  beginDraftChatPromotion(input: DraftChatPromotion): boolean {
    const entries = this.draftPromotionEntries(input);
    if (entries.length === 0) return false;
    this.requireDraftPromotionScope(input, entries, false);
    for (const entry of entries) entry.pendingCanonicalChatId = input.chatId;
    return true;
  }

  /** Cancellation does not undo a committed owner or its presentation wait. */
  cancelDraftChatPromotion(input: DraftChatPromotion): boolean {
    const entries = this.draftPromotionEntries(input).filter(entry => entry.pendingCanonicalChatId === input.chatId);
    if (entries.length === 0) return false;
    for (const entry of entries) delete entry.pendingCanonicalChatId;
    this.rejectPresentationWaiters(input.chatId, input.agentKey);
    return true;
  }

  /** Called only after the trusted Main canonical-sync ACK, never by guest IPC. */
  promoteDraftChat(input: DraftChatPromotion): boolean {
    const entries = this.draftPromotionEntries(input);
    if (entries.length === 0) return false;
    this.requireDraftPromotionScope(input, entries, true);
    for (const entry of entries) {
      entry.ownerChatId = input.chatId;
      delete entry.newChat;
      delete entry.draftScope;
      delete entry.pendingCanonicalChatId;
      entry.promotionPending = true;
    }
    // Identity changes once for the whole group; preview sessions and guests stay live.
    this.publish();
    return true;
  }

  /** Wait only for the promoted files' canonical presentation acknowledgement. */
  async waitForChatPresentation(input: { chatId: string; agentKey: string }): Promise<void> {
    if (!requestText(input.chatId) || !requestText(input.agentKey)) throw new Error(t("dialog.localDocument.readFailed"));
    if (!this.hasPendingPresentation(input.chatId, input.agentKey)) return;
    const owner = this.mainContents();
    if (!owner) throw new Error(t("dialog.localDocument.readFailed"));
    const frame = owner.mainFrame;
    const generation = this.rendererGeneration;
    await new Promise<void>((resolve, reject) => {
      const waiter = {
        ...input, owner, frame, generation, resolve, reject,
        timer: setTimeout(() => {
          this.presentationWaiters.delete(waiter);
          this.clearPendingDraftPromotions(input.chatId, input.agentKey);
          this.rejectPresentationWaiters(input.chatId, input.agentKey);
          reject(new Error(t("dialog.localDocument.readFailed")));
        }, 1500),
      };
      this.presentationWaiters.add(waiter);
      this.settlePresentationWaiters();
    });
  }

  private hasPendingPresentation(chatId: string, agentKey: string) {
    return [...this.documents.values()].some(entry => entry.agentKey === agentKey &&
      (entry.pendingCanonicalChatId === chatId || entry.ownerChatId === chatId && entry.promotionPending));
  }

  private clearPendingDraftPromotions(chatId?: string, agentKey?: string) {
    for (const entry of this.documents.values()) {
      if (chatId !== undefined && (entry.pendingCanonicalChatId !== chatId || entry.agentKey !== agentKey)) continue;
      delete entry.pendingCanonicalChatId;
    }
  }

  private rejectPresentationWaiters(chatId?: string, agentKey?: string) {
    for (const waiter of this.presentationWaiters) {
      if (chatId !== undefined && (waiter.chatId !== chatId || waiter.agentKey !== agentKey)) continue;
      this.presentationWaiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.reject(new Error(t("dialog.localDocument.readFailed")));
    }
  }

  private settlePresentationWaiters() {
    for (const waiter of this.presentationWaiters) {
      const owner = this.mainContents();
      if (owner !== waiter.owner || owner?.mainFrame !== waiter.frame || this.rendererGeneration !== waiter.generation) {
        this.clearPendingDraftPromotions(waiter.chatId, waiter.agentKey);
        this.presentationWaiters.delete(waiter);
        clearTimeout(waiter.timer);
        waiter.reject(new Error(t("dialog.localDocument.readFailed")));
      } else if (!this.hasPendingPresentation(waiter.chatId, waiter.agentKey)) {
        this.presentationWaiters.delete(waiter);
        clearTimeout(waiter.timer);
        waiter.resolve();
      }
    }
  }

  /** Resolve an exact selection captured by a trusted Run's WorkPanel action. */
  async resolveActiveFile(
    request: EditingChat & { documentId: string },
    isSelectionCurrent?: () => Promise<boolean>,
  ): Promise<LocalDocumentActiveFile | null> {
    const unavailable = () => new Error(t("dialog.localDocument.readFailed"));
    if (this.disposed) throw unavailable();
    if (!requestText(request.chatId) || request.newChat !== undefined || !requestText(request.agentKey) || !requestText(request.documentId)) throw unavailable();
    const entry = this.documents.get(request.documentId);
    if (!entry || entry.newChat !== undefined || entry.promotionPending || entry.ownerChatId !== request.chatId || entry.agentKey !== request.agentKey) throw unavailable();

    const owner = this.mainContents();
    const frame = owner?.mainFrame;
    const generation = this.rendererGeneration;
    const binding = entry.binding;
    const requireCurrent = () => {
      if (!owner || this.disposed || this.mainContents() !== owner || owner.mainFrame !== frame ||
          this.rendererGeneration !== generation || this.documents.get(entry.documentId) !== entry ||
          entry.binding !== binding || !this.bindingIsCurrent(entry) ||
          binding?.boundOwnerKey !== localDocumentOwnerKey(entry)) throw unavailable();
    };

    try {
      requireCurrent();
      const canonical = await fs.promises.realpath(entry.filePath);
      requireCurrent();
      if (!this.samePath(canonical, entry.filePath)) throw unavailable();
      const stat = await fs.promises.stat(canonical);
      requireCurrent();
      if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size < 0) throw unavailable();
      // Recheck the exact selected path; a substituted symlink or deleted
      // file must not become authority for a different or stale target.
      const currentPath = await fs.promises.realpath(entry.filePath);
      requireCurrent();
      if (!this.samePath(currentPath, canonical)) throw unavailable();
      const currentStat = await fs.promises.stat(currentPath);
      requireCurrent();
      if (!currentStat.isFile() || currentStat.dev !== stat.dev || currentStat.ino !== stat.ino ||
          !Number.isSafeInteger(currentStat.size) || currentStat.size < 0) throw unavailable();
      // AppShell alone owns active tabs. The action bridge rechecks the same
      // Run Chat selection after filesystem awaits, including background Chats.
      if (isSelectionCurrent && !await isSelectionCurrent()) throw unavailable();
      requireCurrent();
      return {
        fileName: entry.fileName, kind: entry.kind, path: canonical,
        mimeType: entry.kind === "markdown" ? "text/markdown" : "text/html", sizeBytes: currentStat.size,
      };
    } catch {
      // An unavailable explicit selection never falls back to another file.
      throw unavailable();
    }
  }

  registerIpc(ipcMain: IpcMain) {
    if (this.disposed || this.removeIpc) return;
    const channels = [LOCAL_DOCUMENT_CHANNELS.getState, LOCAL_DOCUMENT_CHANNELS.select, LOCAL_DOCUMENT_CHANNELS.activate,
      LOCAL_DOCUMENT_CHANNELS.close, LOCAL_DOCUMENT_CHANNELS.reveal, LOCAL_DOCUMENT_CHANNELS.bind];
    ipcMain.handle(LOCAL_DOCUMENT_CHANNELS.getState, (event) => {
      if (!this.authorize(event)) throw new Error("Local document workspace access denied.");
      return this.snapshot();
    });
    ipcMain.handle(LOCAL_DOCUMENT_CHANNELS.select, async (event): Promise<LocalDocumentActionResult> => {
      if (!this.authorize(event)) return { ok: false };
      const ownerWindow = this.options.getMainWindow();
      const generation = this.rendererGeneration;
      const isCurrent = () => this.rendererGeneration === generation &&
        this.options.getMainWindow() === ownerWindow && this.authorize(event);
      try {
        const result = await this.options.showFileDialog({
          title: t("dialog.localDocument.chooseTitle"),
          properties: ["openFile", "multiSelections"],
          filters: [{ name: "Markdown / HTML", extensions: ["md", "markdown", "html", "htm"] }],
        }, ownerWindow);
        if (!isCurrent()) return { ok: false };
        if (result.canceled || result.filePaths.length === 0) return { ok: true };
        let failureMessage = "";
        for (const filePath of result.filePaths) {
          if (!isCurrent()) return { ok: false };
          try {
            // Selected files follow the same file-Chat reuse policy as OS opens;
            // one invalid file or failed preparation does not block the rest.
            await this.open(filePath, isCurrent);
          } catch (error) {
            const message = error instanceof Error ? error.message : "";
            const known = [t("dialog.localDocument.unsupported"), t("dialog.localDocument.tooLarge"), t("dialog.localDocument.editingChatFailed")];
            failureMessage ||= known.includes(message) ? message : t("dialog.localDocument.readFailed");
          }
          if (!isCurrent()) return { ok: false };
        }
        return failureMessage ? { ok: false, message: failureMessage } : { ok: true };
      } catch { return { ok: false, message: t("dialog.localDocument.readFailed") }; }
    });
    ipcMain.handle(LOCAL_DOCUMENT_CHANNELS.bind, (event, request: unknown): LocalDocumentBindResult => {
      if (!this.authorize(event) || !request || typeof request !== "object") return { ok: false };
      const { documentId, ownerChatId, newChat, rendererGeneration } = request as Record<string, unknown>;
      if (!requestText(documentId) || typeof ownerChatId !== "string" || !requestText(rendererGeneration) ||
          !(requestText(ownerChatId) && newChat === undefined || ownerChatId === "" && isLocalDocumentNewChat(newChat))) return { ok: false };
      const entry = this.documents.get(documentId);
      if (!entry || entry.ownerChatId !== ownerChatId || entry.newChat !== newChat) return { ok: false };
      const routeMatches = entry.newChat
        ? this.options.isEditingChatRequested?.("", entry.agentKey, entry.newChat) === true
        : this.options.isEditingChatActive(entry.ownerChatId, entry.agentKey);
      if (!routeMatches) return { ok: false };
      const binding = entry.binding;
      const boundOwnerKey = localDocumentOwnerKey(entry);
      if (!this.bindingIsCurrent(entry) || binding?.rendererGeneration !== rendererGeneration || binding.boundOwnerKey !== boundOwnerKey) {
        entry.binding = {
          owner: event.sender, frame: event.senderFrame!,
          lifecycleGeneration: this.rendererGeneration, rendererGeneration, boundOwnerKey,
        };
      }
      if (entry.newChat) entry.draftScope = { owner: event.sender, frame: event.senderFrame!, lifecycleGeneration: this.rendererGeneration };
      if (entry.promotionPending) { entry.promotionPending = false; this.settlePresentationWaiters(); }
      return { ok: true, document: this.documentItem(entry) };
    });
    ipcMain.handle(LOCAL_DOCUMENT_CHANNELS.activate, (event, documentId: unknown): LocalDocumentActionResult => {
      if (!this.authorize(event) || typeof documentId !== "string" || !this.documents.has(documentId)) return { ok: false };
      this.activeDocumentId = documentId;
      this.openRevision += 1;
      this.publish();
      this.showDocumentChat(this.documents.get(documentId)!);
      return { ok: true };
    });
    ipcMain.handle(LOCAL_DOCUMENT_CHANNELS.close, (event, documentId: unknown): LocalDocumentActionResult => {
      if (!this.authorize(event) || typeof documentId !== "string") return { ok: false };
      return { ok: this.closeDocument(documentId) };
    });
    ipcMain.handle(LOCAL_DOCUMENT_CHANNELS.reveal, async (event, documentId: unknown): Promise<LocalDocumentActionResult> => {
      if (!this.authorize(event) || typeof documentId !== "string") return { ok: false };
      const entry = this.documents.get(documentId);
      if (!entry) return { ok: false };
      const generation = this.rendererGeneration;
      try {
        const canonical = await fs.promises.realpath(entry.filePath);
        const stat = await fs.promises.stat(canonical);
        if (!this.authorize(event) || this.rendererGeneration !== generation || this.documents.get(documentId) !== entry ||
            !this.samePath(canonical, entry.filePath) || !stat.isFile()) return { ok: false };
        const reveal = this.dependencies.revealFile ?? ((filePath) => shell.showItemInFolder(filePath));
        // Electron dispatches the native selection to Finder / File Explorer.
        if (this.platform === "darwin") reveal(entry.filePath);
        else if (this.platform === "win32") reveal(entry.filePath);
        else reveal(entry.filePath);
        return { ok: true };
      } catch { return { ok: false, message: t("dialog.localDocument.readFailed") }; }
    });
    this.removeIpc = () => channels.forEach((channel) => ipcMain.removeHandler(channel));
  }

  canAttach(url: string, partition: string, ownerWebContentsId: number): boolean {
    const owner = this.mainContents();
    if (!owner || owner.id !== ownerWebContentsId) return false;
    this.observeOwner(owner);
    return [...this.documents.values()].some((entry) => this.bindingIsCurrent(entry) && entry.preview.partition === partition &&
      entry.preview.isDocumentUrl(url) && (!entry.guest || entry.guest.isDestroyed()));
  }

  configureGuest(contents: WebContents): boolean {
    const entry = [...this.documents.values()].find((item) => item.preview.session === contents.session);
    if (!entry) return false;
    const owner = this.mainContents();
    // Node, preload and sandbox preferences are fixed by the main window's
    // will-attach policy before Electron constructs the guest. They cannot be
    // safely changed after attach, so recheck its actual ownership here.
    if (!owner || !this.bindingIsCurrent(entry) || contents.hostWebContents !== owner || contents.getType() !== "webview" ||
        (entry.guest && entry.guest !== contents && !entry.guest.isDestroyed())) {
      contents.close({ waitForBeforeUnload: false });
      return true;
    }
    if (entry.guest === contents) return true;
    this.observeOwner(owner);
    entry.guest = contents;
    entry.preview.configureGuest(contents);
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    const blockNavigation = (event: { preventDefault(): void }, url: string) => {
      if (!entry.preview.isDocumentUrl(url)) event.preventDefault();
    };
    contents.on("will-navigate", blockNavigation);
    contents.on("will-redirect", blockNavigation);
    contents.on("will-attach-webview", (event) => event.preventDefault());
    contents.on("will-prevent-unload", (event) => event.preventDefault());
    contents.on("before-input-event", (event, input) => {
      if (this.documents.get(entry.documentId) !== entry || entry.guest !== contents) return;
      const browserCommand = resolveWorkPanelBrowserShortcut(this.platform, input);
      if (browserCommand) {
        event.preventDefault();
        this.mainContents()?.send(WORK_PANEL_BROWSER_SHORTCUT_CHANNEL, { guestId: contents.id, command: browserCommand });
        return;
      }
      const modifier = this.platform === "darwin" ? input.meta && !input.control :
        this.platform === "win32" ? input.control && !input.meta : input.control && !input.meta;
      if (input.type !== "keyDown" || !modifier || input.alt || input.shift) return;
      if (input.key.toLowerCase() === "w") {
        event.preventDefault();
        this.mainContents()?.send("app.closeShortcut", { guestId: contents.id });
      } else if (input.key.toLowerCase() === "r") {
        event.preventDefault();
        entry.preview.cancelRender();
        contents.reload();
      }
    });
    contents.once("destroyed", () => {
      if (entry.guest === contents) {
        entry.guest = undefined;
        entry.preview.cancelRender();
      }
    });
    return true;
  }

  private mainContents() {
    if (this.disposed) return null;
    const window = this.options.getMainWindow();
    return window && !window.isDestroyed() && !window.webContents.isDestroyed() ? window.webContents : null;
  }

  private authorize(event: IpcMainInvokeEvent) {
    const owner = this.mainContents();
    if (!owner || event.sender !== owner || event.senderFrame !== owner.mainFrame) return false;
    this.observeOwner(owner);
    return true;
  }

  private bindingIsCurrent(entry: DocumentEntry) {
    const binding = entry.binding;
    const owner = this.mainContents();
    return Boolean(binding && owner && binding.owner === owner && binding.frame === owner.mainFrame &&
      binding.lifecycleGeneration === this.rendererGeneration);
  }

  private documentItem(entry: DocumentEntry): LocalDocumentItem {
    return {
      documentId: entry.documentId, fileName: entry.fileName, kind: entry.kind,
      url: entry.preview.url, partition: entry.preview.partition,
      ownerChatId: entry.ownerChatId, agentKey: entry.agentKey, version: entry.version,
      ...(entry.newChat === undefined ? {} : { newChat: entry.newChat }),
    };
  }

  private snapshot(): LocalDocumentWorkspaceState {
    return {
      revision: this.revision,
      openRevision: this.openRevision,
      documents: [...this.documents.values()].map((entry) => this.documentItem(entry)),
      activeDocumentId: this.activeDocumentId,
    };
  }

  private publish() {
    this.revision += 1;
    try { this.mainContents()?.send(LOCAL_DOCUMENT_CHANNELS.changed, this.snapshot()); } catch { /* A later snapshot includes missed updates. */ }
  }

  private observeOwner(owner: WebContents) {
    if (this.owner === owner) return;
    const replacesOwner = Boolean(this.owner);
    this.unobserveOwner?.();
    this.owner = owner;
    if (replacesOwner) this.renewPreviews();
    // Observe only when the trusted renderer first consumes the workspace. A
    // file queued before the initial app navigation must survive cold start.
    const reload = (event: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>) => {
      if (event.isMainFrame && !event.isSameDocument) this.renewPreviews();
    };
    const gone = () => this.renewPreviews();
    const destroyed = () => {
      if (this.owner !== owner) return;
      this.unobserveOwner?.();
      this.clearDocuments();
    };
    owner.on("did-start-navigation", reload);
    owner.on("render-process-gone", gone);
    owner.once("destroyed", destroyed);
    this.unobserveOwner = () => {
      owner.removeListener("did-start-navigation", reload);
      owner.removeListener("render-process-gone", gone);
      owner.removeListener("destroyed", destroyed);
      this.rendererGeneration += 1;
      this.owner = undefined;
      this.unobserveOwner = undefined;
    };
  }

  private watchEntry(entry: DocumentEntry) {
    const listener: FileChangeListener = (current) => {
      if (this.disposed || this.documents.get(entry.documentId) !== entry) return;
      const revision = fileRevision(current);
      if (revision === entry.fileRevision) return;
      entry.fileRevision = revision;
      entry.version += 1;
      entry.preview.cancelRender();
      this.publish();
    };
    const watch = this.dependencies.watchFile ?? fs.watchFile;
    const unwatch = this.dependencies.unwatchFile ?? fs.unwatchFile;
    // Observe this exact selected path. Polling survives atomic replacements
    // and deletion/recreation without granting access to a directory scan.
    watch(entry.filePath, { interval: 750, persistent: false }, listener);
    entry.stopWatching = () => { unwatch(entry.filePath, listener); entry.stopWatching = undefined; };
  }

  private releasePreview(entry: DocumentEntry) {
    const guest = entry.guest;
    entry.guest = undefined;
    entry.binding = undefined;
    entry.preview.dispose();
    if (guest && !guest.isDestroyed()) guest.close({ waitForBeforeUnload: false });
  }

  private releaseEntry(entry: DocumentEntry) {
    entry.stopWatching?.();
    this.releasePreview(entry);
  }

  private renewPreviews() {
    this.clearPendingDraftPromotions();
    this.rejectPresentationWaiters();
    // Also invalidate a pending native picker in an empty workspace.
    this.rendererGeneration += 1;
    if (this.disposed || this.documents.size === 0) return;
    for (const entry of this.documents.values()) {
      this.releasePreview(entry);
      try { entry.preview = new LocalDocumentPreview(entry, this.dependencies); }
      catch { entry.stopWatching?.(); this.documents.delete(entry.documentId); }
    }
    if (!this.activeDocumentId || !this.documents.has(this.activeDocumentId)) {
      this.activeDocumentId = [...this.documents.keys()].at(-1) ?? null;
    }
    this.publish();
  }

  private closeDocument(documentId: string) {
    const entry = this.documents.get(documentId);
    if (!entry) return false;
    if (entry.pendingCanonicalChatId) {
      const pendingChatId = entry.pendingCanonicalChatId;
      this.clearPendingDraftPromotions(pendingChatId, entry.agentKey);
      this.rejectPresentationWaiters(pendingChatId, entry.agentKey);
    }
    if (entry.promotionPending) this.rejectPresentationWaiters(entry.ownerChatId, entry.agentKey);
    const index = [...this.documents.keys()].indexOf(documentId);
    this.documents.delete(documentId);
    this.releaseEntry(entry);
    if (this.activeDocumentId === documentId) {
      const remaining = [...this.documents.keys()];
      this.activeDocumentId = remaining[Math.min(index, remaining.length - 1)] ?? null;
    }
    this.publish();
    return true;
  }

  private clearDocuments() {
    this.rejectPresentationWaiters();
    for (const entry of this.documents.values()) this.releaseEntry(entry);
    this.documents.clear();
    this.activeDocumentId = null;
    this.publish();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.unobserveOwner?.();
    this.removeIpc?.();
    this.removeIpc = undefined;
    this.clearDocuments();
  }
}
