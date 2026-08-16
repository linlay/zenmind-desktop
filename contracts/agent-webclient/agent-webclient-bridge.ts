// Generated from src/shared/contracts/agent-webclient-bridge.ts.
// Do not edit this mirror directly.
// sha256:c6cc34f02e2454c8cf6d924f7411327ab2c02795e44abfec03ddabde10858472

/**
 * Canonical Desktop <-> Agent WebClient bridge contract.
 *
 * Keep this module self-contained: the generated mirror is consumed by the
 * separately released Agent WebClient bundle and must not depend on Electron.
 */

export const AGENT_WEBCLIENT_BRIDGE_VERSION = 1 as const;
export const AGENT_WEBCLIENT_REALTIME_BRIDGE_GLOBAL =
  "__AGENT_WEBCLIENT_REALTIME_BRIDGE__" as const;
export const AGENT_WEBCLIENT_WORKPANEL_BRIDGE_GLOBAL =
  "__AGENT_WEBCLIENT_WORKPANEL_BRIDGE__" as const;

export const AGENT_WEBCLIENT_REALTIME_MESSAGE_CHANNEL =
  "agentWebclient.realtime.message" as const;
export const AGENT_WEBCLIENT_REALTIME_INVOKE_CHANNEL =
  "agentWebclient.realtime.invoke" as const;
export const AGENT_WEBCLIENT_WORKPANEL_INVOKE_CHANNEL =
  "agentWebclient.workpanel.invoke" as const;

export const AGENT_WEBCLIENT_BRIDGE_ERROR_CODES = [
  "bridge_unavailable",
  "version_mismatch",
  "invalid_request",
  "duplicate_id",
  "connection_unavailable",
  "connection_lost_before_acceptance",
  "capability_denied",
  "surface_unavailable",
  "target_unavailable",
  "ambiguous_action_target",
  "unsupported_in_current_view",
  "unsupported_native_surface",
  "seq_expired",
  "replay_required",
  "protocol_error",
  "backpressure",
] as const;

export type AgentWebclientBridgeErrorCode =
  (typeof AGENT_WEBCLIENT_BRIDGE_ERROR_CODES)[number];

export type AgentWebclientSurfaceKind =
  | "agent-chat"
  | "agent-copilot"
  | "agent-summary"
  | "agent-debug"
  | "agent-project";

export type AgentWebclientSurfaceCapability =
  | "run.query"
  | "run.attach"
  | "run.control"
  | "run.visible.read"
  | "push.subscribe"
  | "workpanel.open"
  | "workpanel.activate"
  | "workpanel.close"
  | "inbound.action.owner";

export type AgentWebclientConnectionPhase =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "closing"
  | "closed"
  | "error";

export type AgentWebclientBridgeError = {
  code: AgentWebclientBridgeErrorCode;
  message: string;
  retryable?: boolean;
  details?: Record<string, unknown>;
};

export type AgentWebclientBridgeHello = {
  version: typeof AGENT_WEBCLIENT_BRIDGE_VERSION;
  surface: {
    kind: AgentWebclientSurfaceKind;
    capabilities: AgentWebclientSurfaceCapability[];
    ownerChatId?: string;
    route: string;
  };
  connection: {
    phase: AgentWebclientConnectionPhase;
    generation: number;
  };
};

export type AgentWebclientBridgeHelloInput = {
  version: typeof AGENT_WEBCLIENT_BRIDGE_VERSION;
};

export type AgentWebclientRunOwner =
  | { kind: "agent"; agentKey: string }
  | { kind: "team"; teamId: string };

export type AgentWebclientRunControlKind =
  | "interrupt"
  | "submitAwaiting"
  | "submitTool"
  | "steer"
  | "updateAccessLevel";

export type AgentWebclientRealtimeRequest =
  | {
      version: typeof AGENT_WEBCLIENT_BRIDGE_VERSION;
      operationId: string;
      kind: "run.query";
      chatId: string;
      runId: string;
      owner?: AgentWebclientRunOwner;
      payload: Record<string, unknown>;
    }
  | {
      version: typeof AGENT_WEBCLIENT_BRIDGE_VERSION;
      operationId: string;
      kind: "run.control";
      chatId: string;
      runId: string;
      control: AgentWebclientRunControlKind;
      owner?: AgentWebclientRunOwner;
      payload: Record<string, unknown>;
    };

export type AgentWebclientRunSubscriptionRole =
  | "primary"
  | "summary"
  | "debug"
  | "internal";

export type AgentWebclientRealtimeSubscription =
  | {
      version: typeof AGENT_WEBCLIENT_BRIDGE_VERSION;
      kind: "run";
      chatId: string;
      runId: string;
      lastSeq: number;
      role: Exclude<AgentWebclientRunSubscriptionRole, "internal">;
      owner?: AgentWebclientRunOwner;
    }
  | {
      version: typeof AGENT_WEBCLIENT_BRIDGE_VERSION;
      kind: "push";
      types: string[];
      filter?: {
        chatId?: string;
        runId?: string;
        resourceId?: string;
      };
    };

export type AgentWebclientBridgeAck = {
  ok: true;
  operationId?: string;
  subscriptionId?: string;
};

export type AgentWebclientBridgeFailure = {
  ok: false;
  error: AgentWebclientBridgeError;
};

export type AgentWebclientBridgeResult =
  | AgentWebclientBridgeAck
  | AgentWebclientBridgeFailure;

export type AgentWebclientRealtimeMessage =
  | {
      version: typeof AGENT_WEBCLIENT_BRIDGE_VERSION;
      kind: "connection";
      phase: AgentWebclientConnectionPhase;
      generation: number;
    }
  | {
      version: typeof AGENT_WEBCLIENT_BRIDGE_VERSION;
      kind: "run.accepted";
      operationId: string;
      chatId: string;
      runId: string;
      agentKey?: string;
    }
  | {
      version: typeof AGENT_WEBCLIENT_BRIDGE_VERSION;
      kind: "run.batch";
      subscriptionId: string;
      bindingEpoch: number;
      chatId: string;
      runId: string;
      events: Array<Record<string, unknown>>;
      lastSeq: number;
    }
  | {
      version: typeof AGENT_WEBCLIENT_BRIDGE_VERSION;
      kind: "run.completed";
      operationId?: string;
      subscriptionId?: string;
      chatId: string;
      runId: string;
      reason: string;
      lastSeq?: number;
    }
  | {
      version: typeof AGENT_WEBCLIENT_BRIDGE_VERSION;
      kind: "push";
      subscriptionId: string;
      type: string;
      data?: unknown;
    }
  | {
      version: typeof AGENT_WEBCLIENT_BRIDGE_VERSION;
      kind: "error";
      operationId?: string;
      subscriptionId?: string;
      error: AgentWebclientBridgeError;
    };

export type WorkPanelContext = {
  chatId?: string;
  runId?: string;
  agentKey?: string;
  projectId?: string;
  artifactId?: string;
  nodeId?: string;
  relativePath?: string;
};

export type WorkPanelWebclientModule =
  | "summary"
  | "debug"
  | "project"
  | "file-diff"
  | "artifact"
  | "planning"
  | "agent"
  | "copilot";

export type WorkPanelItemDescriptor =
  | {
      kind: "webclient";
      module: WorkPanelWebclientModule;
      route: string;
      context: WorkPanelContext;
      title?: string;
      pinned?: boolean;
      closable?: boolean;
    }
  | {
      kind: "native";
      surfaceKey: string;
      context: WorkPanelContext;
      title?: string;
      pinned?: boolean;
      closable?: boolean;
    }
  | {
      kind: "web";
      url: string;
      title?: string;
      pinned?: boolean;
      closable?: boolean;
    };

export type WorkPanelItem = {
  itemId: string;
  stableKey: string;
  descriptor: WorkPanelItemDescriptor;
  title: string;
  closable: boolean;
  pinned: boolean;
  createdAt: number;
};

export type WorkPanelWorkspace = {
  workspaceId: string;
  ownerChatId: string;
  items: WorkPanelItem[];
  activeItemId: string | null;
};

export type WorkPanelOpenItemInput = {
  version: typeof AGENT_WEBCLIENT_BRIDGE_VERSION;
  descriptor: WorkPanelItemDescriptor;
};

export type WorkPanelItemTargetInput = {
  version: typeof AGENT_WEBCLIENT_BRIDGE_VERSION;
  itemId: string;
};

export type WorkPanelBridgeResult =
  | { ok: true; workspaceId: string; item?: WorkPanelItem; state?: WorkPanelWorkspace }
  | AgentWebclientBridgeFailure;

export type AgentWebclientRealtimeBridge = {
  hello(): Promise<AgentWebclientBridgeHello | AgentWebclientBridgeFailure>;
  request(input: AgentWebclientRealtimeRequest): Promise<AgentWebclientBridgeResult>;
  subscribe(input: AgentWebclientRealtimeSubscription): Promise<AgentWebclientBridgeResult>;
  unsubscribe(subscriptionId: string): Promise<AgentWebclientBridgeResult>;
  onMessage(listener: (message: AgentWebclientRealtimeMessage) => void): () => void;
};

export type AgentWebclientWorkPanelBridge = {
  openItem(input: WorkPanelOpenItemInput): Promise<WorkPanelBridgeResult>;
  activateItem(input: WorkPanelItemTargetInput): Promise<WorkPanelBridgeResult>;
  closeItem(input: WorkPanelItemTargetInput): Promise<WorkPanelBridgeResult>;
};

export function isAgentWebclientBridgeVersion(value: unknown): value is 1 {
  return value === AGENT_WEBCLIENT_BRIDGE_VERSION;
}

export function isPlainBridgeRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isAgentWebclientSurfaceKind(value: unknown): value is AgentWebclientSurfaceKind {
  return [
    "agent-chat",
    "agent-copilot",
    "agent-summary",
    "agent-debug",
    "agent-project",
  ].includes(String(value));
}
