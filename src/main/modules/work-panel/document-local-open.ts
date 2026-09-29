import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { SaveDialogOptions, SaveDialogReturnValue } from "electron";
import type { AgentWebclientBridgeFailure, WorkPanelDocumentSource } from "../../../shared/contracts/agent-webclient-bridge";
import {
  listLocalDocumentApplications,
  openWithLocalApplication,
  LocalDocumentApplicationError,
  type LocalDocumentApplication,
  type LocalDocumentExtension,
} from "../../infrastructure/electron/local-document-apps";
import { isLocalDocumentBytes } from "./document-local-open-format";

type LocalOpenFailureCode = "local_app_query_failed" | "local_app_unavailable" | "unsupported_document_type"
  | "document_save_failed" | "application_launch_failed" | "target_unavailable" | "capability_denied" | "invalid_request" | "duplicate_id";
type ApplicationOption = Omit<LocalDocumentApplication, "path">;
type OptionsResult = { ok: true; applications: ApplicationOption[] } | AgentWebclientBridgeFailure;
type OpenResult = { ok: true; status: "cancelled" | "launch-requested" } | AgentWebclientBridgeFailure;

export type DocumentLocalOpenPorts = {
  readDocument(source: WorkPanelDocumentSource): Promise<{
    fileName: string;
    bytes: Buffer;
    originalPath?: string;
    protectedRoots?: string[];
  }>;
  showSaveDialog(options: SaveDialogOptions): Promise<SaveDialogReturnValue>;
  getDownloadsPath(): string;
  resolveFileName?(source: WorkPanelDocumentSource): string;
  listApplications?(extension: LocalDocumentExtension): Promise<LocalDocumentApplication[]>;
  openApplication?(application: LocalDocumentApplication, filePath: string, stillOwned?: () => boolean): Promise<void>;
  platform?: NodeJS.Platform;
};

class LocalOpenError extends Error {
  constructor(readonly code: LocalOpenFailureCode, message: string) { super(message); }
}
const failure = (code: LocalOpenFailureCode, message: string): AgentWebclientBridgeFailure => ({ ok: false, error: { code, message } });
const unavailable = () => new LocalOpenError("target_unavailable", "The document is no longer available.");
function assertOwned(stillOwned: () => boolean): void { if (!stillOwned()) throw unavailable(); }
const LOCAL_DOCUMENT_EXTENSIONS = new Set([".ppt", ".pptx", ".doc", ".docx", ".xls", ".xlsx", ".pdf"]);

function documentFileName(source: WorkPanelDocumentSource): string {
  const sourcePath = source.kind === "workspace-file" ? source.path : source.relativePath;
  return sourcePath.replace(/\\/g, "/").split("/").at(-1) ?? "";
}

function documentExtension(fileName: string): LocalDocumentExtension | null {
  const extension = path.extname(fileName).toLowerCase();
  if (!fileName || /[\x00-\x1f\x7f/\\]/.test(fileName) || !LOCAL_DOCUMENT_EXTENSIONS.has(extension)) return null;
  return extension as LocalDocumentExtension;
}

function comparisonPath(filePath: string, platform: NodeJS.Platform): string {
  if (platform === "win32") {
    // fs.realpath may return extended-length paths while the save dialog does not.
    const regularPath = filePath.replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\/, "");
    return path.win32.resolve(regularPath).toLowerCase();
  }
  return path.posix.resolve(filePath);
}

export function isLocalDocumentPathWithinRoot(filePath: string, root: string, platform: NodeJS.Platform): boolean {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const relative = paths.relative(comparisonPath(root, platform), comparisonPath(filePath, platform));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${paths.sep}`) && !paths.isAbsolute(relative));
}

const sameFileIdentity = (left: { dev: number; ino: number }, right: { dev: number; ino: number }) =>
  left.dev === right.dev && left.ino === right.ino;

async function statIfPresent(filePath: string) {
  try { return await fs.lstat(filePath); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

async function protectedRootPath(root: string, stillOwned: () => boolean): Promise<string> {
  let candidate = path.resolve(root);
  const missing: string[] = [];
  while (true) {
    const stat = await statIfPresent(candidate);
    assertOwned(stillOwned);
    if (stat) {
      // A missing local resource store can still protect its future location.
      // A dangling link or a permission failure, however, must remain closed.
      if (!stat.isDirectory() && !stat.isSymbolicLink()) throw new Error("Invalid protected document storage");
      const real = await fs.realpath(candidate);
      assertOwned(stillOwned);
      return path.join(real, ...missing.reverse());
    }
    const parent = path.dirname(candidate);
    if (parent === candidate) throw new Error("Document storage is unavailable");
    missing.push(path.basename(candidate));
    candidate = parent;
  }
}

async function safeSaveTarget(
  selectedPath: string,
  extension: LocalDocumentExtension,
  document: { originalPath?: string; protectedRoots?: string[] },
  platform: NodeJS.Platform,
  stillOwned: () => boolean,
): Promise<string> {
  const deny = () => new LocalOpenError("document_save_failed", "Choose a separate copy outside the original document storage.");
  if (!path.isAbsolute(selectedPath) || path.extname(selectedPath).toLowerCase() !== extension || /[\x00-\x1f\x7f]/.test(selectedPath)) throw deny();
  const basename = path.basename(selectedPath);
  if (platform === "win32" && (/[<>:"|?*]/.test(basename) || /[. ]$/.test(basename) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(basename) || /^\\\\[?.]\\/.test(selectedPath))) throw deny();
  const selected = path.resolve(selectedPath);
  const parent = await fs.realpath(path.dirname(selected));
  assertOwned(stillOwned);
  const target = path.join(parent, basename);
  const targetStat = await statIfPresent(target);
  assertOwned(stillOwned);
  if (targetStat && !targetStat.isFile()) throw deny();
  if (document.originalPath) {
    if (comparisonPath(target, platform) === comparisonPath(document.originalPath, platform)) throw deny();
    const originalPath = await fs.realpath(document.originalPath);
    assertOwned(stillOwned);
    if (comparisonPath(target, platform) === comparisonPath(originalPath, platform)) throw deny();
    const originalStat = await fs.stat(originalPath);
    assertOwned(stillOwned);
    if (!originalStat.isFile() || (targetStat && sameFileIdentity(originalStat, targetStat))) throw deny();
  }
  for (const root of document.protectedRoots ?? []) {
    if (isLocalDocumentPathWithinRoot(selected, root, platform) || isLocalDocumentPathWithinRoot(target, root, platform)) throw deny();
    const realRoot = await protectedRootPath(root, stillOwned);
    assertOwned(stillOwned);
    if (isLocalDocumentPathWithinRoot(target, realRoot, platform)) throw deny();
  }
  return target;
}

async function saveCompleteCopy(
  selectedPath: string,
  extension: LocalDocumentExtension,
  document: { bytes: Buffer; originalPath?: string; protectedRoots?: string[] },
  platform: NodeJS.Platform,
  stillOwned: () => boolean,
): Promise<string> {
  const target = await safeSaveTarget(selectedPath, extension, document, platform, stillOwned);
  assertOwned(stillOwned);
  const temp = path.join(path.dirname(target), `.zenmind-office-${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  let committed = false;
  try {
    handle = await fs.open(temp, "wx", 0o600);
    assertOwned(stillOwned);
    await handle.writeFile(document.bytes);
    assertOwned(stillOwned);
    await handle.sync();
    assertOwned(stillOwned);
    await handle.close();
    handle = undefined;
    assertOwned(stillOwned);
    const checkedTarget = await safeSaveTarget(selectedPath, extension, document, platform, stillOwned);
    assertOwned(stillOwned);
    if (comparisonPath(checkedTarget, platform) !== comparisonPath(target, platform)) {
      throw new LocalOpenError("document_save_failed", "The selected save location changed. Choose it again.");
    }
    // Same-directory rename leaves an existing destination intact if the copy
    // write fails. Never unlink an existing file as a Windows fallback.
    await fs.rename(temp, target);
    committed = true;
    assertOwned(stillOwned);
    return target;
  } finally {
    if (handle) await handle.close().catch(() => {});
    if (!committed) await fs.unlink(temp).catch(() => {});
  }
}

export function createDocumentLocalOpenService(ports: DocumentLocalOpenPorts) {
  const platform = ports.platform ?? process.platform;
  const listApplications = ports.listApplications ?? listLocalDocumentApplications;
  const openApplication = ports.openApplication ?? openWithLocalApplication;
  const fileNameFor = ports.resolveFileName ?? documentFileName;
  const pending = new Set<string>();
  const supported = platform === "darwin" || platform === "win32";

  async function getOptions(source: WorkPanelDocumentSource, stillOwned: () => boolean): Promise<OptionsResult> {
    try {
      assertOwned(stillOwned);
      if (!supported) return failure("capability_denied", "Local document applications are unavailable on this platform.");
      const extension = documentExtension(fileNameFor(source));
      if (!extension) return failure("unsupported_document_type", "This file type cannot be opened with a local document application.");
      const applications = await listApplications(extension);
      assertOwned(stillOwned);
      return { ok: true, applications: applications.map(({ id, name, isDefault, iconDataUrl }) => ({
        id, name, isDefault, ...(iconDataUrl ? { iconDataUrl } : {}),
      })) };
    } catch (error) {
      if (!stillOwned()) return failure("target_unavailable", "The document is no longer available.");
      if (error instanceof LocalOpenError) return failure(error.code, error.message);
      return failure("local_app_query_failed", "Unable to read the installed document applications.");
    }
  }

  async function openCopy(source: WorkPanelDocumentSource, applicationId: string, stillOwned: () => boolean): Promise<OpenResult> {
    let key: string | undefined;
    let phase: LocalOpenFailureCode = "invalid_request";
    try {
      assertOwned(stillOwned);
      if (!supported) return failure("capability_denied", "Local document applications are unavailable on this platform.");
      const fileName = fileNameFor(source);
      const extension = documentExtension(fileName);
      if (!extension) return failure("unsupported_document_type", "This file type cannot be opened with a local document application.");
      if (typeof applicationId !== "string" || !applicationId || applicationId.length > 4096 || /[\x00-\x1f\x7f]/.test(applicationId)) {
        return failure("invalid_request", "Select an available document application.");
      }
      const sourceKey = source.kind === "workspace-file"
        ? JSON.stringify([source.kind, source.agentKey, source.path])
        : JSON.stringify([source.kind, source.agentKey, source.chatId, source.resourceId, source.relativePath]);
      if (pending.has(sourceKey)) return failure("duplicate_id", "This document is already being opened.");
      key = sourceKey;
      pending.add(key);
      phase = "local_app_query_failed";
      const applications = await listApplications(extension);
      assertOwned(stillOwned);
      if (!applications.some((application) => application.id === applicationId)) {
        return failure("local_app_unavailable", "The selected application is no longer available.");
      }
      phase = "document_save_failed";
      const selected = await ports.showSaveDialog({
        defaultPath: path.join(ports.getDownloadsPath(), fileName),
        filters: [{ name: extension.slice(1).toUpperCase(), extensions: [extension.slice(1)] }],
      });
      assertOwned(stillOwned);
      if (selected.canceled || !selected.filePath) return { ok: true, status: "cancelled" };
      if (path.extname(selected.filePath).toLowerCase() !== extension) {
        return failure("document_save_failed", "Keep the original document extension when saving the copy.");
      }
      phase = "target_unavailable";
      const document = await ports.readDocument(source);
      assertOwned(stillOwned);
      if (documentExtension(document.fileName) !== extension || !(await isLocalDocumentBytes(document.bytes, extension))) {
        assertOwned(stillOwned);
        return failure("unsupported_document_type", "The document content does not match the supported file type.");
      }
      assertOwned(stillOwned);
      phase = "document_save_failed";
      const target = await saveCompleteCopy(selected.filePath, extension, document, platform, stillOwned);
      assertOwned(stillOwned);
      // A save dialog can remain open while an application is moved/uninstalled.
      // Requery the explicit choice rather than following a changed default.
      phase = "local_app_query_failed";
      const currentApplications = await listApplications(extension);
      assertOwned(stillOwned);
      const application = currentApplications.find((candidate) => candidate.id === applicationId);
      if (!application) return failure("local_app_unavailable", "The selected application is no longer available. The saved copy was kept.");
      phase = "application_launch_failed";
      await openApplication(application, target, stillOwned);
      assertOwned(stillOwned);
      return { ok: true, status: "launch-requested" };
    } catch (error) {
      if (!stillOwned()) return failure("target_unavailable", "The document is no longer available.");
      if (error instanceof LocalOpenError) return failure(error.code, error.message);
      if (error instanceof LocalDocumentApplicationError && error.code === "application-unavailable") {
        return failure("local_app_unavailable", "The selected application is no longer available. The saved copy was kept.");
      }
      const messages: Record<LocalOpenFailureCode, string> = {
        invalid_request: "The local document request is invalid.",
        duplicate_id: "This document is already being opened.",
        capability_denied: "Local document applications are unavailable on this platform.",
        local_app_query_failed: "Unable to read the installed document applications.",
        local_app_unavailable: "The selected application is no longer available.",
        unsupported_document_type: "This file type cannot be opened with a local document application.",
        target_unavailable: "The document is no longer available.",
        document_save_failed: "Unable to save a separate local copy of this document.",
        application_launch_failed: "Unable to open the selected application. The saved copy was kept.",
      };
      return failure(phase, messages[phase]);
    } finally { if (key !== undefined) pending.delete(key); }
  }

  return { getOptions, openCopy };
}
