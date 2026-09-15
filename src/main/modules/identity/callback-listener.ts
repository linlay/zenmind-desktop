import http from "node:http";
import type { AddressInfo } from "node:net";

export function callbackListenHosts(host: string, platform: NodeJS.Platform = process.platform) {
  if (host !== "localhost") return [host];
  // Windows browsers and Node can choose different localhost address families.
  if (platform === "win32") return ["127.0.0.1", "::1"];
  // macOS also needs both loopbacks; never bind a wildcard network interface.
  if (platform === "darwin") return ["127.0.0.1", "::1"];
  return ["127.0.0.1", "::1"];
}

function listen(server: http.Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen({ port, host, ipv6Only: host === "::1" }, () => {
      server.off("error", onError);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

export async function listenCallbackServers(
  servers: http.Server[], port: number, host: string
) {
  try {
    const hosts = callbackListenHosts(host);
    const actualPort = await listen(servers[0], port, hosts[0]);
    for (const extraHost of hosts.slice(1)) {
      const server = http.createServer((request, response) => servers[0].emit("request", request, response));
      servers.push(server);
      try {
        await listen(server, actualPort, extraHost);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        // An OS with IPv6 disabled can still serve localhost over IPv4.
        // Port conflicts and permission failures must not silently degrade.
        if (code !== "EAFNOSUPPORT" && code !== "EADDRNOTAVAIL") throw error;
        servers.pop();
        server.close();
      }
    }
    return actualPort;
  } catch (error) {
    for (const server of servers) server.close();
    throw error;
  }
}
