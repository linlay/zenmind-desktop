import fs from "node:fs";
import path from "node:path";
import type { App } from "electron";
import type { WorkPanelDocumentSource } from "../../../shared/contracts/agent-webclient-bridge";
import { normalizeWorkPanelDocumentSource } from "../../../shared/work-panel-document-source";
import { resolvePreferredAgentPlatformRuntimeRoot } from "../services";
import { resolveWorkPanelDocumentFromWorkspace } from "./document-workspace-path";
import { normalizeChatWorkPanelOpenLocalResourceRequest, resolveChatWorkPanelResourceFile } from "./resource-open";
import { LOCAL_DOCUMENT_MAX_BYTES } from "./document-local-open-format";

export type DocumentLocalReaderPorts = {
  app: App;
  platform?: NodeJS.Platform;
  resolveRuntimeRoot?(app: App): string;
  getWorkspace(agentKey: string): Promise<string | null>;
  verifyChatOwner(chatId: string, agentKey: string): Promise<boolean>;
  fetchResource(chatId: string, relativePath: string): Promise<Buffer>;
};

async function readBoundedFile(filePath: string): Promise<Buffer> {
  const file = await fs.promises.open(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size <= 0 || before.size > LOCAL_DOCUMENT_MAX_BYTES) throw new Error("Document is unavailable");
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      total += chunk.length;
      if (total > LOCAL_DOCUMENT_MAX_BYTES) throw new Error("Document exceeds the local-open size limit");
      chunks.push(Buffer.from(chunk));
    }
    const after = await file.stat();
    const current = await fs.promises.stat(filePath);
    if (before.dev !== current.dev || before.ino !== current.ino || before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs || total !== after.size) throw new Error("Document changed while being read");
    return Buffer.concat(chunks, total);
  } finally {
    await file.close();
  }
}

async function canonicalRuntimeRoot(root: string): Promise<string> {
  let candidate = path.resolve(root);
  const missing: string[] = [];
  while (true) {
    try {
      // lstat distinguishes a genuinely missing directory from a dangling link.
      const stat = await fs.promises.lstat(candidate);
      if (!stat.isDirectory() && !stat.isSymbolicLink()) throw new Error("Document storage is unavailable");
      return path.join(await fs.promises.realpath(candidate), ...missing.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      try {
        if ((await fs.promises.lstat(candidate)).isSymbolicLink()) throw new Error("Document storage link is unavailable");
      } catch (linkError) {
        if ((linkError as NodeJS.ErrnoException).code !== "ENOENT") throw linkError;
      }
      const parent = path.dirname(candidate);
      if (parent === candidate) throw new Error("Document storage is unavailable");
      missing.push(path.basename(candidate));
      candidate = parent;
    }
  }
}

async function verifyChatAncestors(runtimeRoot: string, chatId: string, relativePath: string) {
  const chatRoot = path.join(runtimeRoot, "chats", chatId);
  let candidate = runtimeRoot;
  const parts = ["chats", chatId, ...relativePath.split("/")];
  for (let index = 0; index < parts.length; index++) {
    candidate = path.join(candidate, parts[index]);
    let stat: fs.Stats;
    try { stat = await fs.promises.lstat(candidate); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    // A Chat directory may not alias a different Chat. Links inside the Chat
    // can be followed only when their canonical target stays in that Chat.
    if (stat.isSymbolicLink()) {
      if (index < 2) throw new Error("Chat document storage is aliased");
      candidate = await fs.promises.realpath(candidate);
      const relative = path.relative(chatRoot, candidate);
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error("Chat document escapes its storage");
      }
    }
  }
}

/** Resolves only semantic documents already bound to a trusted WorkPanel surface. */
export function createWorkPanelDocumentReader(ports: DocumentLocalReaderPorts) {
  return async (requestedSource: WorkPanelDocumentSource) => {
    const source = normalizeWorkPanelDocumentSource(requestedSource);
    if (!source) throw new Error("Invalid document source");
    const runtimeRoot = await canonicalRuntimeRoot((ports.resolveRuntimeRoot ?? resolvePreferredAgentPlatformRuntimeRoot)(ports.app));
    const protectedRoots = [runtimeRoot];
    if (source.kind === "workspace-file") {
      const workspace = await ports.getWorkspace(source.agentKey);
      if (!workspace || workspace === "@chat") throw new Error("Agent workspace is unavailable");
      const resolved = resolveWorkPanelDocumentFromWorkspace(workspace, source.path, ports.platform);
      if (!resolved.ok) throw new Error("Workspace document is unavailable");
      const bytes = await readBoundedFile(resolved.filePath);
      // Re-resolve after asynchronous reads: a changed directory/symlink cannot
      // turn the original authorization into access to a different file.
      const current = resolveWorkPanelDocumentFromWorkspace(workspace, source.path, ports.platform);
      if (!current.ok || current.filePath !== resolved.filePath) throw new Error("Workspace document changed");
      return { fileName: path.posix.basename(source.path), bytes, originalPath: resolved.filePath, protectedRoots };
    }
    if (!await ports.verifyChatOwner(source.chatId, source.agentKey)) throw new Error("Document Chat is unavailable");
    const request = normalizeChatWorkPanelOpenLocalResourceRequest({ ownerChatId: source.chatId, profile: source.kind, relativePath: source.relativePath });
    if (!request) throw new Error("Invalid Chat document source");
    await verifyChatAncestors(runtimeRoot, source.chatId, request.relativePath);
    const dependencies = { app: ports.app, platform: ports.platform, resolveRuntimeRoot: () => runtimeRoot };
    const resolved = resolveChatWorkPanelResourceFile(request, dependencies, "openDefault");
    const fileName = path.posix.basename(source.relativePath);
    if (resolved.ok) {
      const bytes = await readBoundedFile(resolved.path);
      await verifyChatAncestors(runtimeRoot, source.chatId, request.relativePath);
      const current = resolveChatWorkPanelResourceFile(request, dependencies, "openDefault");
      if (!current.ok || current.path !== resolved.path) throw new Error("Chat document changed");
      return { fileName, bytes, originalPath: resolved.path, protectedRoots };
    }
    // Only a genuinely missing local copy may use the authenticated data plane.
    // Traversal, symlink escape and other authorization failures stay closed.
    if (resolved.code !== "not_found") throw new Error("Chat document is unavailable");
    const bytes = await ports.fetchResource(source.chatId, source.relativePath);
    if (!bytes.length || bytes.length > LOCAL_DOCUMENT_MAX_BYTES) throw new Error("Document exceeds the local-open size limit");
    return { fileName, bytes, protectedRoots };
  };
}
