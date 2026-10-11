export function isSupportedDesktopDocumentPath(filePath: string): boolean {
  return !filePath.includes("\0") && /\.(?:md|markdown|html|htm)$/i.test(filePath);
}

export function isLocalDocumentNewChat(value: unknown): value is string {
  return typeof value === "string" && /^[1-9]\d{12}$/u.test(value);
}

/** A draft grouping key belongs only to the local renderer, never Platform APIs. */
export function localDocumentOwnerKey(document: { ownerChatId: string; agentKey: string; newChat?: string }): string {
  if (document.ownerChatId) return document.newChat === undefined ? document.ownerChatId : "";
  return document.agentKey.trim() && isLocalDocumentNewChat(document.newChat)
    ? `file-draft:${encodeURIComponent(document.agentKey)}:${document.newChat}`
    : "";
}

export const LOCAL_DOCUMENT_CHANNELS = {
  getState: "localDocuments.getState",
  changed: "localDocuments.changed",
  activate: "localDocuments.activate",
  close: "localDocuments.close",
  reveal: "localDocuments.reveal",
  select: "localDocuments.select",
  bind: "localDocuments.bind",
} as const;

export type LocalDocumentItem = {
  documentId: string;
  fileName: string;
  kind: "markdown" | "html";
  url: string;
  partition: string;
  ownerChatId: string;
  newChat?: string;
  agentKey: string;
  version: number;
};

export type LocalDocumentBindRequest = {
  documentId: string;
  ownerChatId: string;
  newChat?: string;
  rendererGeneration: string;
};

export type LocalDocumentBindResult = LocalDocumentActionResult & { document?: LocalDocumentItem };

export type LocalDocumentWorkspaceState = {
  revision: number;
  openRevision: number;
  documents: LocalDocumentItem[];
  activeDocumentId: string | null;
};

export type LocalDocumentActionResult = { ok: boolean; message?: string };

export type LocalDocumentsApi = {
  select(): Promise<LocalDocumentActionResult>;
  bind(request: LocalDocumentBindRequest): Promise<LocalDocumentBindResult>;
  getState(): Promise<LocalDocumentWorkspaceState>;
  activate(documentId: string): Promise<LocalDocumentActionResult>;
  close(documentId: string): Promise<LocalDocumentActionResult>;
  reveal(documentId: string): Promise<LocalDocumentActionResult>;
  onChanged(listener: (state: LocalDocumentWorkspaceState) => void): () => void;
};
