export type AssistantDocumentFormat = "text" | "pdf" | "docx" | "xlsx" | "pptx" | "zip" | "image" | "binary";
export type AssistantDocumentReadStatus = "readable" | "truncated" | "unreadable";

export interface AssistantAttachmentDocument {
  format: AssistantDocumentFormat;
  readStatus: AssistantDocumentReadStatus;
  extractedChars: number;
  truncated: boolean;
  pageCount?: number;
  sheetNames?: string[];
  slideCount?: number;
  imageMode?: "vision";
  errorCode?: string;
  visionSummary?: string;
  visionStatus?: "pending" | "readable" | "failed" | "unavailable";
}

export interface AssistantAttachment {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  text: string;
  dataUrl?: string;
  truncated?: boolean;
  error?: string;
  kind?: "input" | "artifact";
  artifactId?: string;
  description?: string;
  sha256?: string;
  url?: string;
  document?: AssistantAttachmentDocument;
  hidden?: boolean;
  sourceAttachmentId?: string;
  pageNumber?: number;
}

export interface AssistantAttachmentPickResult {
  ok: boolean;
  chatId: string;
  message: string;
  attachments: AssistantAttachment[];
  taskId?: string;
  cancelled?: boolean;
}

export type AssistantAttachmentTaskPhase =
  | "queued"
  | "scanning"
  | "copying"
  | "extracting"
  | "rendering"
  | "complete"
  | "cancelled"
  | "error";

export interface AssistantAttachmentTaskProgress {
  taskId: string;
  chatId: string;
  phase: AssistantAttachmentTaskPhase;
  processedFiles: number;
  totalFiles: number;
  processedBytes: number;
  totalBytes: number;
  message: string;
  done?: boolean;
  cancelled?: boolean;
}

export type AssistantAttachmentProgressListener = (progress: AssistantAttachmentTaskProgress) => void;

export interface AssistantAttachmentCancelResult {
  ok: boolean;
  message: string;
}
