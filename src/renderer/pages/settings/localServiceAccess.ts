import type { ServiceState } from "../../../shared/contracts";

// Publish only a live loopback endpoint, never a configured default or stale URL.
export function localServiceBaseUrl(service: ServiceState | undefined): string {
  if (service?.status !== "running") return "";
  const port = service.healthMeta.port;
  if (!Number.isInteger(port) || !port || port < 1 || port > 65535) return "";
  return `http://127.0.0.1:${port}`;
}

export function platformConnectionExamples(baseUrl: string, isWindows: boolean) {
  const wsUrl = new URL("/ws", baseUrl);
  wsUrl.protocol = "ws:";
  // Windows PowerShell aliases curl in some versions; explicitly use curl.exe.
  const curl = isWindows ? "curl.exe" : "curl";
  return {
    wsUrl: wsUrl.href,
    http: `${curl} --fail-with-body --max-time 15 "${baseUrl}/api/agents" -H "Authorization: Bearer YOUR_ACCESS_TOKEN"`,
    websocket: `const token = "YOUR_ACCESS_TOKEN";
const ws = new WebSocket(${JSON.stringify(wsUrl.href)}, ["bearer." + token]);
const timeout = setTimeout(() => ws.close(), 15000);
ws.onmessage = ({ data }) => {
  const frame = JSON.parse(data);
  if (frame.frame === "push" && frame.type === "connected") {
    if (frame.data?.protocolVersion !== 2) {
      ws.close();
      return;
    }
    ws.send(JSON.stringify({
      frame: "request", type: "/api/agents", id: "agents-1", payload: {}
    }));
  }
  if (frame.id === "agents-1") {
    console.log(frame);
    ws.close();
  }
};
ws.onerror = () => console.error("WebSocket connection failed");
ws.onclose = () => clearTimeout(timeout);`
  };
}
