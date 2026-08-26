export const CHAT_WORK_PANEL_BLANK_URL = "about:blank";

export type ChatWorkPanelWorkspace = {
  chatId: string;
  surfaceId: string;
  generation: string;
  partition: string;
  initialUrl: string;
  initialTitle?: string;
};

export type ChatWorkPanelClearSessionRequest = {
  partition: string;
};

export const CHAT_WORK_PANEL_LOCAL_FILE_PROTOCOL = "zenmind-local-file";

export type WorkPanelLocalFilePreviewKind =
  | "html"
  | "pdf"
  | "image"
  | "text"
  | "audio"
  | "video"
  | "unsupported";

export type WorkPanelLocalFileSelection = {
  handleId: string;
  fileName: string;
  previewKind: WorkPanelLocalFilePreviewKind;
  reviewKind?: "html" | "image";
  workspaceRelativePath?: string;
  reviewRevision?: string;
};

export type WorkPanelLocalFileSelectRequest = {
  ownerChatId: string;
  rendererGeneration: string;
};

export type WorkPanelLocalFileHandleRequest = WorkPanelLocalFileSelectRequest & {
  handleId: string;
};

export type WorkPanelLocalFileReleaseRequest = WorkPanelLocalFileSelectRequest & {
  handleIds: string[];
};

export type WorkPanelLocalFileClaimRequest = WorkPanelLocalFileSelectRequest & {
  claimId: string;
};

export type WorkPanelLocalFileSelectionResult = {
  ok: boolean;
  files: WorkPanelLocalFileSelection[];
  message?: string;
};

export type WorkPanelLocalFileClaimResult = {
  ok: boolean;
  file?: WorkPanelLocalFileSelection;
  reused?: boolean;
  message?: string;
};

export type WorkPanelLocalFileActionResult = {
  ok: boolean;
  message?: string;
};

export function createWorkPanelLocalFilePartition(handleId: string) {
  return `work-panel-local-file-${handleId.trim()}`;
}

export function createWorkPanelLocalFileUrl(handleId: string, fileName: string) {
  const normalizedHandleId = handleId.trim();
  const normalizedFileName = fileName.trim();
  return normalizedHandleId && normalizedFileName
    ? `${CHAT_WORK_PANEL_LOCAL_FILE_PROTOCOL}://${encodeURIComponent(normalizedHandleId)}/${encodeURIComponent(normalizedFileName)}`
    : "";
}

export function normalizeChatWorkPanelUrl(value: unknown) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (raw === CHAT_WORK_PANEL_BLANK_URL) {
    return raw;
  }
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : "";
  } catch {
    return "";
  }
}
