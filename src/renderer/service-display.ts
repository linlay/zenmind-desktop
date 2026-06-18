import type { TranslateFunction } from "../shared/i18n";

export function getAgentWebclientDisplayName(t: TranslateFunction) {
  return t("service.display.agentWebclient");
}

export function getServiceDisplayName(serviceId: string, serviceName: string, t: TranslateFunction) {
  if (serviceId === "agent-container-hub") {
    return t("service.display.containerHub");
  }
  if (serviceId === "identity-center") {
    return t("service.display.identityCenter");
  }
  if (serviceId === "agent-webclient") {
    return getAgentWebclientDisplayName(t);
  }
  return serviceName;
}

const HIDDEN_NAVIGATION_SERVICE_IDS = new Set([
  "agent-platform",
  "identity-center"
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
