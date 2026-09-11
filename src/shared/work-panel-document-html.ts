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

export const WORK_PANEL_DOCUMENT_HTML_PROTOCOL = "zenmind-document-html";
export const WORK_PANEL_DOCUMENT_HTML_REVIEW_CHANNEL = "work-panel.document-html.review";
export const WORK_PANEL_DOCUMENT_HTML_REVIEW_EVENT = "work-panel.document-html.review-event";

export type WorkPanelDocumentHtmlPreviewRequest = WorkPanelDocumentHtmlHandleRequest;

export type WorkPanelDocumentHtmlPreviewResult = {
  ok: boolean;
  url?: string;
  partition?: string;
  revision?: string;
  message?: string;
};

export type WorkPanelDocumentHtmlFileActionRequest = WorkPanelDocumentHtmlHandleRequest & {
  action: "reveal" | "open-default" | "open-browser" | "save-copy";
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
