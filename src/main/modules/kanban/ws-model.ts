import type {
  KanbanListResult,
  KanbanIssueResult,
  DesktopPetAgentOption,
  AssistantStartRunRequest,
  AssistantStartRunResult,
  KanbanProject
} from "../../../shared/contracts";
import type { KanbanCloudSnapshot } from "./store-model";

export type MinimalWebSocket = {
  onopen: (() => void) | null;
  onmessage: ((event: { data?: unknown }) => void) | null;
  onclose: ((event?: unknown) => void) | null;
  onerror: ((event?: unknown) => void) | null;
  addEventListener?: (type: string, listener: (event?: unknown) => void) => void;
  readyState?: number;
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
};

export type MinimalWebSocketConstructor = new (url: string) => MinimalWebSocket;

export type KanbanEnvelope = {
  v?: number;
  frame?: "request" | "response" | "push" | "stream" | string;
  type?: string;
  id?: string;
  role?: string;
  boardId?: string;
  projectId?: string;
  revision?: number;
  payload?: unknown;
  ok?: boolean;
  error?: {
    code?: string;
    message?: string;
  };
};

export type PendingRequest = {
  messageType: string;
  resolve: (payload: KanbanEnvelope) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

export type KanbanDesktopConnectionState = NonNullable<KanbanListResult["connectionState"]>;

export type KanbanDesktopWsConfig = {
  serverUrl: string;
  token?: string;
  selectedProjectId?: string;
};

export type KanbanDesktopDeviceInfo = {
  deviceName: string;
  deviceAlias?: string;
  hostname?: string;
  username?: string;
};

export type KanbanDesktopSyncCursor = {
  lastAckedDeliverySeq: number;
  lastAppliedRevision: number;
  cacheSchemaVersion?: number;
};

export type KanbanDesktopSyncLocalProject = {
  projectId: string;
  localProjectId: string;
  localDisplayName: string;
  controlMode?: string;
};

export type KanbanDesktopDelivery = {
  deliveryId?: number;
  deviceId?: string;
  deliverySeq: number;
  projectId?: string | null;
  localProjectId?: string | null;
  kind: string;
  sourceRevision?: number | null;
  commandId?: string | null;
  eventType: string;
  payload?: unknown;
  status?: string;
};

export type KanbanDesktopIssueEvent = {
  seq: number;
  eventType: string;
  projectId?: string | null;
  issueId?: string;
  deletedIssueId?: string;
  issue?: unknown;
  reason?: string;
  fromProjectId?: string;
  toProjectId?: string;
  payload?: unknown;
  actor?: unknown;
  createdAt?: string;
};

export type KanbanDesktopDeliveryApplyResult = {
  ok: boolean;
  lastAppliedRevision?: number;
  message?: string;
};

export type KanbanDesktopIssueEventApplyResult = KanbanDesktopDeliveryApplyResult;

export type KanbanDesktopWsLogEntry = {
  event: "frame";
  direction: "send" | "recv";
  bytes: number;
  envelope: unknown;
};

export type KanbanDesktopWsClientOptions = {
  capabilities: string[];
  getDeviceId: () => string;
  getDeviceInfo?: () => KanbanDesktopDeviceInfo;
  getSyncCursor?: () => KanbanDesktopSyncCursor;
  onSyncCursor?: (cursor: KanbanDesktopSyncCursor) => void;
  onSnapshot: (snapshot: KanbanCloudSnapshot) => void;
  onDelivery?: (delivery: KanbanDesktopDelivery) => Promise<KanbanDesktopDeliveryApplyResult>;
  onDeliveryAcked?: (delivery: KanbanDesktopDelivery) => void | Promise<void>;
  onIssueEvent?: (event: KanbanDesktopIssueEvent) => Promise<KanbanDesktopIssueEventApplyResult>;
  onDispatchIssue: (
    issue: unknown,
    revision: number
  ) => KanbanIssueResult;
  onListAgents: () => Promise<DesktopPetAgentOption[]>;
  onStartRun: (request: AssistantStartRunRequest) => Promise<AssistantStartRunResult>;
  onAutomationSync: (payload: unknown) => Promise<unknown>;
  onListLocalProjects: () => Promise<{ ok: boolean; projects: KanbanProject[]; message?: string }>;
  onListSyncLocalProjects?: () => Promise<KanbanDesktopSyncLocalProject[]>;
  onCreateLocalProject: (payload: unknown) => Promise<unknown>;
  onBindProject: (payload: unknown) => Promise<unknown>;
  onUnbindProject: (payload: unknown) => Promise<unknown>;
  onConnected?: () => void;
  onContractNegotiated?: (contractVersion: string, capabilities: string[]) => void;
  onStateChanged?: (state: KanbanDesktopConnectionState) => void;
  onDebug?: (message: string) => void;
  onWsLog?: (entry: KanbanDesktopWsLogEntry) => void;
};
