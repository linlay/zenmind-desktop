export const MAX_CONVERSATION_HTML_BYTES = 20 * 1024 * 1024;
export const MAX_CONVERSATION_SNAPSHOT_BYTES = 20 * 1024 * 1024;
export const MAX_CONVERSATION_TEMPLATE_BYTES = 256 * 1024;
export const CONVERSATION_EXPORT_TEMPLATE_PATH = "/assets/conversation-export/conversation.template.html";
export const CONVERSATION_EXPORT_SNAPSHOT_MARKER = "__CONVERSATION_EXPORT_SNAPSHOT_JSON_V1__";
export const CONVERSATION_EXPORT_ASSET_ORIGIN_MARKER = "__CONVERSATION_EXPORT_ASSET_ORIGIN__";

export type ConversationHtmlWorkerErrorCode =
  | "request_invalid"
  | "snapshot_unauthorized"
  | "snapshot_unavailable"
  | "snapshot_invalid"
  | "template_unavailable"
  | "template_invalid"
  | "too_large"
  | "worker_failed";

export type ConversationHtmlRenderResult =
  | { ok: true; bytes: Buffer; filename: string }
  | { ok: false; message: string };

export type ConversationSnapshotReadResult =
  | { ok: true; bytes: Buffer }
  | { ok: false; message: string };

export type ConversationSnapshotReader = {
  readChatSnapshot(chatId: string): Promise<ConversationSnapshotReadResult>;
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
};

export type ReadConversationSnapshotRequest = {
  kind: "snapshot";
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
};

export type RenderConversationHtmlFailure = {
  type: "error";
  requestId: string;
  code: ConversationHtmlWorkerErrorCode;
  actualBytes?: number;
  limitBytes?: number;
};

export type RenderConversationHtmlResponse =
  | RenderConversationHtmlSuccess
  | ReadConversationSnapshotSuccess
  | RenderConversationHtmlFailure;
