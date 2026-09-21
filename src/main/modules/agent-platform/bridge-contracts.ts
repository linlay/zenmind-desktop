import { type ServiceId, type AssistantStartRunResult, type AssistantStartRunRequest } from "../../../shared/contracts";

export const AGENT_PLATFORM_SERVICE_ID: ServiceId = "agent-platform";

export const MAX_CONVERSATION_MARKDOWN_BYTES = 2 << 20;

export const MAX_RAW_CHAT_JSONL_BYTES = 100 * 1024 * 1024;

export const MAX_GENERATED_IMAGE_BYTES = 32 * 1024 * 1024;

export type ApiResponse<T> = {
  code: number;
  msg: string;
  data: T;
};

export type AgentPlatformChatExportResult =
  | { ok: true; message: string; filename: string; bytes: Buffer }
  | { ok: false; message: string; filename: string; bytes?: never };

export type AgentPlatformRawChatJSONLResult =
  | { ok: true; filename: string; bytes: Buffer }
  | { ok: false; message: string; filename?: never; bytes?: never };

export type AssistantRunWakeLock = {
  acquire: () => void;
  release: () => void;
};

export type ActiveAssistantRun = {
  controller: AbortController;
  chatId: string;
  agentKey: string;
  baseUrl: string;
  token: string;
  acceptance?: Promise<AssistantStartRunResult>;
};

export type PlatformUploadTicket = {
  id?: string;
  type?: string;
  name?: string;
  mimeType?: string;
  sizeBytes?: number;
  url?: string;
  sha256?: string;
  sandboxPath?: string;
};

export type AgentPlatformImageOperation =
  | "generate"
  | "imageToImage"
  | "inpaint"
  | "outpaint"
  | "removeObject"
  | "replaceBackground"
  | "removeBackground"
  | "enhance"
  | "repairSelection";

export type AgentPlatformImageCompletionRequest = Omit<AssistantStartRunRequest, "message"> & {
  operation: AgentPlatformImageOperation;
  prompt: string;
  negativePrompt?: string;
  width: number;
  height: number;
  count: number;
  strength: number;
  seed: number;
  preserveComposition: boolean;
  edgeMode: "strict" | "soft";
};

export type AgentPlatformImageCompletionResult =
  | {
      ok: true;
      runId: string;
      chatId: string;
      message: string;
      images: Array<{
        name: string;
        mimeType: "image/png" | "image/jpeg" | "image/webp";
        sizeBytes: number;
        sha256: string;
        dataBase64: string;
      }>;
    }
  | {
      ok: false;
      runId: string;
      chatId: string;
      message: string;
      images: [];
    };

export type PlatformChatSummary = {
  chatId?: unknown;
  chatName?: unknown;
  agentKey?: unknown;
  firstAgentKey?: unknown;
  workerKey?: unknown;
  teamId?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  lastRunId?: unknown;
  lastRunContent?: unknown;
  read?: unknown;
  isRead?: unknown;
  awaiting?: unknown;
  hasPendingAwaiting?: unknown;
  awaitingCount?: unknown;
  awaitingMode?: unknown;
  mode?: unknown;
  status?: unknown;
  activeRun?: unknown;
  hasActiveRun?: unknown;
};

export type PlatformRunSummary = {
  runId?: unknown;
  initialMessage?: unknown;
  assistantText?: unknown;
  startedAt?: unknown;
  completedAt?: unknown;
};

export type PlatformChatDetail = {
  chatId?: unknown;
  chatName?: unknown;
  agentKey?: unknown;
  firstAgentKey?: unknown;
  firstAgentName?: unknown;
  teamId?: unknown;
  source?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  lastRunId?: unknown;
  lastRunContent?: unknown;
  events?: Array<Record<string, unknown>>;
  runs?: PlatformRunSummary[];
  [key: string]: unknown;
};

export type PlatformChatSearchResponse = {
  query?: string;
  count?: number;
  results?: unknown;
};

export type PlatformArchiveChatResponse = {
  results?: Array<{
    chatId?: string;
    success?: boolean;
    error?: string;
  }>;
};

export type PlatformAgentSummary = {
  key?: string;
  name?: string;
  displayName?: string;
  role?: string;
  icon?: unknown;
  stats?: {
    unreadCount?: number;
    totalCount?: number;
  };
  chats?: unknown;
};

export type PlatformAdminRegistryListResponse = {
  items?: Array<{
    category?: string;
    file?: string;
    key?: string;
    status?: string;
    summary?: {
      syncStatus?: string;
      toolCount?: number;
      syncDiagnostic?: {
        message?: string;
      };
    };
    diagnostic?: {
      message?: string;
    };
  }>;
};
