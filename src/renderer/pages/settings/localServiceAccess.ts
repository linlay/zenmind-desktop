import type { ServiceState } from "../../../shared/contracts";

// Keep the configured endpoint visible while stopped; runtime state supplies any reassigned port.
export function localServiceBaseUrl(service: ServiceState | undefined): string {
  if (!service) return "";
  const port = service.healthMeta.port;
  if (!Number.isInteger(port) || !port || port < 1 || port > 65535) return "";
  return `http://127.0.0.1:${port}`;
}

export function platformConnectionExamples(baseUrl: string, isWindows: boolean, token?: string) {
  let expiresAtMs: number | undefined;
  if (token !== undefined) {
    if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) throw new Error("Invalid access token");
    const payload = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const claims = JSON.parse(atob(payload.padEnd(Math.ceil(payload.length / 4) * 4, "=")));
    if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp)) throw new Error("Missing token expiration");
    expiresAtMs = claims.exp * 1000;
    if (expiresAtMs <= Date.now()) throw new Error("Expired access token");
  }
  const accessToken = token ?? "YOUR_ACCESS_TOKEN";
  const wsUrl = new URL("/ws", baseUrl);
  wsUrl.protocol = "ws:";
  // Windows PowerShell aliases curl in some versions; explicitly use curl.exe.
  const curl = isWindows ? "curl.exe" : "curl";
  return {
    wsUrl: wsUrl.href,
    expiresAtMs,
    http: `${curl} --fail-with-body --max-time 15 "${baseUrl}/api/agents" -H "Authorization: Bearer ${accessToken}"`,
    websocket: `const token = ${JSON.stringify(accessToken)};
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
