export const AGENT_WEBCLIENT_DISPLAY_NAME = "智能助理";

export function getServiceDisplayName(serviceId: string, serviceName: string) {
  if (serviceId === "agent-container-hub") {
    return "容器仓库";
  }
  if (serviceId === "agent-webclient") {
    return AGENT_WEBCLIENT_DISPLAY_NAME;
  }
  return serviceName;
}

const HIDDEN_NAVIGATION_SERVICE_IDS = new Set([
  "agent-platform",
  "zenmind-app-server"
]);

export function shouldShowServiceNavigationTab(service: {
  id: string;
  frontendMode: string;
  status: string;
}) {
  return (
    service.frontendMode === "standalone" &&
    service.status === "running" &&
    service.id !== "agent-webclient" &&
    !HIDDEN_NAVIGATION_SERVICE_IDS.has(service.id)
  );
}
