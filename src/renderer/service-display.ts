export function getServiceDisplayName(serviceId: string, serviceName: string) {
  if (serviceId === "agent-container-hub") {
    return "容器仓库";
  }
  return serviceName;
}
