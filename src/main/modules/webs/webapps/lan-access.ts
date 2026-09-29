import http from "node:http";
import os from "node:os";
import type net from "node:net";

export function isPrivateIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10 || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168) || (parts[0] === 169 && parts[1] === 254);
}

export function getLanUrls(port: number, interfaces = os.networkInterfaces(), platform = process.platform): string[] {
  const priority = (name: string) => {
    // Prefer common physical adapters over VPN/container adapters; names differ by OS.
    if (platform === "darwin") return /^en\d+$/u.test(name) ? 0 : 1;
    if (platform === "win32") return /^(?:Wi-Fi|Ethernet|WLAN|以太网|无线网络)/iu.test(name) ? 0 : 1;
    return /^(?:eth|en|wl)/u.test(name) ? 0 : 1;
  };
  const entries = Object.entries(interfaces).sort(([left], [right]) =>
    priority(left) - priority(right) || left.localeCompare(right));
  return [...new Set(entries.flatMap(([, addresses]) => (addresses ?? [])
    .filter((entry) => entry.family === "IPv4" && !entry.internal && isPrivateIpv4(entry.address))
    .map((entry) => `http://${entry.address}:${port}/`).sort()))];
}

// A separate listener keeps Desktop's loopback origin and running guest stable.
export function createLanAccess(localServer: http.Server, allowPath: (url: string | undefined) => boolean) {
  let server: http.Server | null = null;
  let port = 0;
  let closed = false;
  let pending: Promise<void> = Promise.resolve();
  const sockets = new Set<net.Socket>();
  const allowed = (req: http.IncomingMessage) => {
    const peer = (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
    return (peer === "127.0.0.1" || isPrivateIpv4(peer)) && allowPath(req.url);
  };
  async function stop() {
    const current = server;
    server = null;
    port = 0;
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    if (current) await new Promise<void>((resolve, reject) => current.close((error) => error ? reject(error) : resolve()));
  }
  function setEnabled(enabled: boolean): Promise<void> {
    const task = pending.then(async () => {
      if (closed || !enabled) return stop();
      if (server) return;
      const next = http.createServer((req, res) => {
        if (!allowed(req)) {
          res.writeHead(403, { "Cache-Control": "no-store" });
          res.end("LAN access to this resource is forbidden");
          return;
        }
        localServer.emit("request", req, res);
      });
      next.on("connection", (socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
      });
      next.on("upgrade", (req, socket, head) => {
        if (!allowed(req)) {
          socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
          return;
        }
        localServer.emit("upgrade", req, socket, head);
      });
      await new Promise<void>((resolve, reject) => {
        next.once("error", reject);
        // Node's explicit IPv4 bind is the same on macOS and Windows; no firewall rules are changed.
        next.listen(0, "0.0.0.0", () => { next.removeListener("error", reject); resolve(); });
      });
      server = next;
      const address = next.address();
      port = typeof address === "object" && address ? address.port : 0;
    });
    pending = task.catch(() => undefined);
    return task;
  }
  return {
    get urls() { return port ? getLanUrls(port) : []; },
    setEnabled,
    async close() { closed = true; await setEnabled(false); }
  };
}
