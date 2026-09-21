export type ConnectorAuthMode = "token" | "oneid-token" | "oauth" | "mcp" | null;
export type ConnectorAuthStatus = "pending_verification" | "not_required" | "delegated" | "configured" | "setup_required" | "unauthorized" | "preparing" | "pending" | "authorized" | "failed" | "canceled";
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
  readiness: "configuration_required" | "pending_verification" | "preparing" | "authorization_required" | "ready" | "unavailable";
  authentication: MarketConnectorAuthSession;
  preparation?: MarketConnectorPreparation;
  capabilities: {
    canConnect: boolean;
    canDisconnect: boolean;
    canCheck: boolean;
    authMode: ConnectorAuthMode;
    authBrowser: "system" | "embedded";
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
export interface MarketConnectorDisconnectResult {
  connectorId: string;
  configured: boolean;
  warnings?: string[];
}
