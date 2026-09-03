export type WorkPanelDocumentSource =
  | { kind: "workspace-file"; agentKey: string; path: string }
  | {
      kind: "artifact" | "reference";
      agentKey: string;
      chatId: string;
      resourceId: string;
      relativePath: string;
    };

export type WorkPanelDocumentHtmlSelection = {
  handleId: string;
  sourceKind: WorkPanelDocumentSource["kind"];
  stableIdentity: string;
  displayUrl: string;
  fileName: string;
  mimeType: "text/html" | "application/xhtml+xml";
  sizeBytes: number;
  revision: string;
  localOriginal: boolean;
};

export type WorkPanelDocumentHtmlClaimRequest = {
  ownerChatId: string;
  rendererGeneration: string;
  claimId: string;
};

export type WorkPanelDocumentHtmlHandleRequest = {
  ownerChatId: string;
  rendererGeneration: string;
  handleId: string;
};

export type WorkPanelDocumentHtmlReleaseRequest = {
  ownerChatId: string;
  rendererGeneration: string;
  handleIds: string[];
};

export type WorkPanelDocumentHtmlClaimResult = {
  ok: boolean;
  document?: WorkPanelDocumentHtmlSelection;
  reused?: boolean;
  message?: string;
};

export type WorkPanelDocumentHtmlReadResult = {
  ok: boolean;
  text?: string;
  revision?: string;
  message?: string;
};

export type WorkPanelDocumentHtmlPreviewRequest = WorkPanelDocumentHtmlHandleRequest & {
  text: string;
};

export type WorkPanelDocumentHtmlPreviewResult = {
  ok: boolean;
  text?: string;
  message?: string;
};

export type WorkPanelDocumentHtmlCommitRequest = WorkPanelDocumentHtmlHandleRequest & {
  mode: "overwrite" | "new-artifact";
  expectedRevision: string;
  text: string;
};

export type WorkPanelDocumentHtmlCommitResult = {
  ok: boolean;
  document?: WorkPanelDocumentHtmlSelection;
  created?: boolean;
  conflict?: boolean;
  message?: string;
};

export type WorkPanelDocumentHtmlActionResult = { ok: boolean; message?: string };
