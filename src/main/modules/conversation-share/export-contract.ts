export type ConversationShareLimits = { maxSnapshotBytes: number; maxResourceBytes: number };

export const MAX_CONVERSATION_TEMPLATE_BYTES = 256 * 1024;
export const CONVERSATION_EXPORT_TEMPLATE_PATH = "/assets/conversation-export/conversation.template.html";
export const CONVERSATION_EXPORT_SNAPSHOT_MARKER = "__CONVERSATION_EXPORT_SNAPSHOT_JSON_V1__";
export const CONVERSATION_EXPORT_ASSET_ORIGIN_MARKER = "__CONVERSATION_EXPORT_ASSET_ORIGIN__";
export const CONVERSATION_EXPORT_LOCAL_BRAND_ID_MARKER = "__CONVERSATION_EXPORT_LOCAL_BRAND_ID__";

export type ConversationHtmlWorkerErrorCode =
  | "request_invalid"
  | "snapshot_unauthorized"
  | "snapshot_unavailable"
  | "snapshot_invalid"
  | "template_unavailable"
  | "template_invalid"
  | "too_large"
  | "export_too_large"
  | "resource_exhausted"
  | "worker_failed";

export type ConversationHtmlRenderResult =
  | { ok: true; bytes: Buffer; filename: string }
  | { ok: false; message: string };

export type ConversationSnapshotReadResult =
  | { ok: true; bytes: Buffer; attachments: Array<{ id: string; name: string; mimeType: string; bytes: Buffer }>; attachmentsOmitted: boolean; attachmentUnauthorized: boolean }
  | { ok: false; message: string };

export type ConversationSnapshotReader = {
  readChatSnapshot(chatId: string, limits: ConversationShareLimits): Promise<ConversationSnapshotReadResult>;
};

export type ConversationHtmlRenderer = {
  renderChatHtml(
    chatId: string,
    assetOrigin: string
  ): Promise<ConversationHtmlRenderResult>;
};

export type RenderConversationHtmlRequest = {
  kind: "html";
  requestId: string;
  snapshotUrl: string;
  bearerToken: string;
  templateUrl: string;
  templateCacheKey: string;
  assetOrigin: string;
  brandId: string;
};

export type ReadConversationSnapshotRequest = {
  kind: "snapshot";
  /** V2 manifest is assembled in this same worker, never in Main. */
  shareSourceId?: string;
  limits: ConversationShareLimits;
  requestId: string;
  snapshotUrl: string;
  bearerToken: string;
};

export type ConversationExportWorkerRequest =
  | RenderConversationHtmlRequest
  | ReadConversationSnapshotRequest;

export type RenderConversationHtmlSuccess = {
  type: "result";
  requestId: string;
  filename: string;
  html: ArrayBuffer;
};

export type ReadConversationSnapshotSuccess = {
  type: "snapshot";
  requestId: string;
  snapshot: ArrayBuffer;
  attachments: Array<{ id: string; name: string; mimeType: string; bytes: ArrayBuffer }>;
  attachmentsOmitted: boolean;
  attachmentUnauthorized: boolean;
};

export type RenderConversationHtmlFailure = {
  type: "error";
  requestId: string;
  code: ConversationHtmlWorkerErrorCode;
  limitBytes?: number;
};

export type RenderConversationHtmlResponse =
  | RenderConversationHtmlSuccess
  | ReadConversationSnapshotSuccess
  | RenderConversationHtmlFailure;
