import http from "node:http";
import net from "node:net";
import { type WebappEntry } from "../../../../shared/contracts";
import { type WebappLauncherCheck } from "./launchers";
import { type ChildProcess } from "node:child_process";
import { t } from "../../../support/i18n/main-i18n";
import { probeHttpUrl, delay } from "../../services";

export const HOST = "127.0.0.1";

export const HEALTH_INTERVAL_MS = 250;

export const HEALTH_MONITOR_INTERVAL_MS = 5_000;

export const HEALTH_MONITOR_FAILURE_THRESHOLD = 3;

export async function listen(server: http.Server, port: number) {
  return new Promise<number>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, HOST);
  });
}

export async function reservePort(port: number) {
  const server = http.createServer();
  const resolvedPort = await listen(server, port);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return resolvedPort;
}

export function probeTcp(backendUrl: string, timeoutMs: number) {
  return new Promise<{ ok: boolean; message: string }>((resolve) => {
    let url: URL;
    try {
      url = new URL(backendUrl);
    } catch {
      resolve({ ok: false, message: "TCP health check endpoint is invalid." });
      return;
    }
    const port = Number.parseInt(url.port, 10);
    const host = url.hostname.replace(/^\[|\]$/gu, "");
    if (!host || !Number.isInteger(port)) {
      resolve({ ok: false, message: "TCP health check endpoint is invalid." });
      return;
    }
    const socket = net.createConnection({ host, port });
    const finish = (ok: boolean, message: string) => {
      socket.destroy();
      resolve({ ok, message });
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true, ""));
    socket.once("timeout", () => finish(false, "TCP health check timed out."));
    socket.once("error", (error) => finish(false, error.message));
  });
}

export async function waitForBackendHealth(
  item: WebappEntry,
  check: WebappLauncherCheck,
  child: ChildProcess | null
) {
  if (!item.backend || !check.backendPort) {
    throw new Error("backend endpoint is unavailable");
  }
  const deadline = Date.now() + item.backend.health.startupTimeoutMs;
  let lastMessage = "";
  while (Date.now() < deadline) {
    if (child && (child.exitCode !== null || child.signalCode !== null)) {
      throw new Error(t("service.processExited", { reason: child.exitCode ?? child.signalCode ?? "unknown" }));
    }
    const probe = item.backend.health.type === "http"
      ? await probeHttpUrl(`${check.backendUrl}${item.backend.health.path}`, { timeoutMs: 1000 })
      : await probeTcp(check.backendUrl, 1000);
    if (probe.ok) {
      return;
    }
    lastMessage = probe.message ?? "";
    await delay(HEALTH_INTERVAL_MS);
  }
  throw new Error(t("service.healthTimeout", { message: lastMessage || check.backendUrl }));
}

export async function probeBackendHealthOnce(item: WebappEntry, backendUrl: string) {
  if (!item.backend || !backendUrl) {
    return { ok: false, message: "backend endpoint is unavailable" };
  }
  return item.backend.health.type === "http"
    ? probeHttpUrl(`${backendUrl}${item.backend.health.path}`, { timeoutMs: 1_500 })
    : probeTcp(backendUrl, 1_500);
}
