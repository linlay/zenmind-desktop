import type { MarketConnectorConnection } from "@shared/contracts/market-connector-state";
import type { TranslationKey } from "../../../shared/i18n";
import { connectorIsUsable } from "./connectorFlow";

interface ConnectorPresentation {
  labelKey: TranslationKey;
  tone: "ready" | "pending" | "unavailable" | "idle";
  tagColor?: "success" | "warning" | "error";
}

/** Configuration and invocation readiness are not evidence of a verified account. */
export function connectorPresentation(
  connection: MarketConnectorConnection | undefined,
  installed: boolean,
  { checking = false, stateUnavailable = false }: { checking?: boolean; stateUnavailable?: boolean } = {}
): ConnectorPresentation {
  if (stateUnavailable) return { labelKey: "market.connector.flow.stateUnavailable", tone: "unavailable", tagColor: "warning" };
  if (checking) return { labelKey: "market.connector.flow.checking", tone: "pending" };
  if (!connection) return { labelKey: installed ? "market.connector.flow.stateUnavailable" : "market.connector.flow.notInstalled", tone: installed ? "unavailable" : "idle" };

  const status = connection.authentication.status;
  if (status === "unauthorized" && connection.configured) return { labelKey: "market.connector.flow.state.authorization_required", tone: "pending", tagColor: "warning" };
  if (status === "failed" || connection.readiness === "unavailable") return { labelKey: "market.connector.flow.state.unavailable", tone: "unavailable", tagColor: "warning" };
  if (connectorIsUsable(connection)) {
    if (status === "configured") return { labelKey: "market.connector.flow.configured", tone: "pending", tagColor: "warning" };
    if (status === "delegated") return { labelKey: "market.connector.flow.state.delegated", tone: "pending", tagColor: "warning" };
    if (status === "authorized") return { labelKey: "market.connector.flow.state.verified", tone: "ready", tagColor: "success" };
    return { labelKey: connection.readiness === "no_auth" ? "market.connector.flow.state.no_auth" : "market.connector.flow.state.ready", tone: "ready", tagColor: "success" };
  }
  // Contradictory cached snapshots must not turn an auth failure green.
  if (connection.readiness === "ready") return { labelKey: "market.connector.flow.state.unavailable", tone: "unavailable", tagColor: "warning" };
  return { labelKey: `market.connector.flow.state.${connection.readiness}` as TranslationKey, tone: "pending", tagColor: connection.readiness === "authorization_required" ? "warning" : undefined };
}
