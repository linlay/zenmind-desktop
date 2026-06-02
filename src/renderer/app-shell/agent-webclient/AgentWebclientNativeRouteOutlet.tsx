import type { AgentWebclientResolvedRoute } from "../../../shared/agent-webclient-routes";

export function AgentWebclientNativeRouteOutlet({
  route
}: {
  route: AgentWebclientResolvedRoute | null;
}) {
  if (route?.mode !== "native") {
    return null;
  }

  return null;
}
