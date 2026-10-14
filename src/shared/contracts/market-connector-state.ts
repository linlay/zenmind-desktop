export type ConnectorAuthMode = "no_auth" | "token" | "oneid-token" | "oauth" | "mcp" | null;
export type ConnectorAuthStatus = "no_auth" | "pending_verification" | "not_required" | "delegated" | "configured" | "setup_required" | "unauthorized" | "preparing" | "pending" | "authorized" | "failed" | "canceled";
export interface MarketConnectorAuthSession {
  connectorId: string;
  sessionId: string;
  status: ConnectorAuthStatus;
  authBrowser?: "system" | "embedded";
  authorizationUrl?: string;
  message?: string;
  expiresAt: string;
  pendingVerification?: boolean;
}
export interface MarketConnectorPreparation {
  connectorId: string;
  status: "pending" | "preparing" | "ready" | "failed" | "canceled";
  stage?: string;
  message?: string;
}
export interface MarketConnectorConnection {
  connectorId: string;
  configured: boolean;
  configurationRequired?: boolean;
  readiness: "no_auth" | "configuration_required" | "pending_verification" | "preparing" | "authorization_required" | "ready" | "unavailable";
  authentication: MarketConnectorAuthSession;
  preparation?: MarketConnectorPreparation;
  capabilities: {
    canConnect: boolean;
    canDisconnect: boolean;
    canCheck: boolean;
    authMode: ConnectorAuthMode;
    authBrowser: "" | "system" | "embedded";
    hasCli: boolean;
    hasMcp: boolean;
  };
}
export interface MarketConnectorTokenSchema {
  title?: string;
  description?: string;
  docUrl?: string;
  docLabel?: string;
  fields: Array<{ key: string; label: string; type: "text" | "password"; required: boolean; placeholder?: string; description?: string; defaultValue?: string }>;
}
export interface MarketConnectorAgentState {
  agentKey: string;
  connectorIds: string[];
  activeConnectorIds: string[];
  reloadPending: boolean;
}
/** One connector's MCP tool state in an Agent's current published version. */
export interface MarketConnectorAgentToolState {
  agentKey: string;
  connectorId: string;
  /** The saved Agent configuration has not been published to new Runs yet. */
  reloadPending: boolean;
  /** `unmounted` means the published version does not include this connector. */
  mcp: Array<{
    serverKey: string;
    status: "pending" | "syncing" | "ready" | "unavailable" | "unmounted";
    toolCount: number;
  }>;
}
export interface MarketConnectorDisconnectResult {
  connectorId: string;
  configured: boolean;
  warnings?: string[];
}
