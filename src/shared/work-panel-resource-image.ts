export type WorkPanelResourceImageProfile = "artifact" | "reference";

export type WorkPanelResourceImageMimeType =
  | "image/png"
  | "image/jpeg"
  | "image/webp";

export type WorkPanelResourceImageSelection = {
  handleId: string;
  profile: WorkPanelResourceImageProfile;
  agentKey: string;
  chatId: string;
  resourceId: string;
  relativePath: string;
  fileName: string;
  mimeType: WorkPanelResourceImageMimeType;
  sizeBytes: number;
  revision: string;
  localOriginal: boolean;
};

export type WorkPanelResourceImageClaimRequest = {
  ownerChatId: string;
  rendererGeneration: string;
  claimId: string;
};

export type WorkPanelResourceImageHandleRequest = {
  ownerChatId: string;
  rendererGeneration: string;
  handleId: string;
};

export type WorkPanelResourceImageReleaseRequest = {
  ownerChatId: string;
  rendererGeneration: string;
  handleIds: string[];
};

export type WorkPanelResourceImageClaimResult = {
  ok: boolean;
  resource?: WorkPanelResourceImageSelection;
  reused?: boolean;
  message?: string;
};

export type WorkPanelResourceImageReadResult = {
  ok: boolean;
  data?: Uint8Array;
  revision?: string;
  message?: string;
};

export type WorkPanelResourceImageExternalOpenRequest =
  WorkPanelResourceImageHandleRequest & { mode: "default" | "choose" };

export type WorkPanelResourceImageActionResult = {
  ok: boolean;
  message?: string;
};

export type WorkPanelResourceImageAiOperation =
  | "removeObject"
  | "removeBackground"
  | "replaceBackground"
  | "outpaint"
  | "enhance";

export type WorkPanelResourceImageAiRequest = WorkPanelResourceImageHandleRequest & {
  requestId: string;
  expectedRevision: string;
  operation: WorkPanelResourceImageAiOperation;
  sourceMimeType: WorkPanelResourceImageMimeType;
  sourceDataBase64: string;
  maskDataBase64?: string;
  prompt?: string;
  width: number;
  height: number;
  preserveComposition: boolean;
  edgeMode: "strict" | "soft";
};

export type WorkPanelResourceImageAiResult = {
  ok: boolean;
  requestId: string;
  runId?: string;
  chatId?: string;
  image?: {
    name: string;
    mimeType: WorkPanelResourceImageMimeType;
    sizeBytes: number;
    sha256: string;
    dataBase64: string;
  };
  message?: string;
};

export type WorkPanelResourceImageAiCancelRequest =
  WorkPanelResourceImageHandleRequest & { requestId: string };

export type WorkPanelResourceImageCommitRequest = WorkPanelResourceImageHandleRequest & {
  mode: "overwrite" | "new-artifact";
  expectedRevision: string;
  mimeType: WorkPanelResourceImageMimeType;
  dataBase64: string;
  hasTransparency: boolean;
};

export type WorkPanelResourceImageCommitResult = {
  ok: boolean;
  resource?: WorkPanelResourceImageSelection;
  created?: boolean;
  conflict?: boolean;
  message?: string;
};

export type WorkPanelResourceImageChangedEvent = {
  handleId: string;
  revision: string;
};

export const WORK_PANEL_RESOURCE_IMAGE_CHANGED_CHANNEL =
  "chatWorkPanel.resourceImages.changed" as const;
