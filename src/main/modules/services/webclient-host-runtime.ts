import { AgentWebclientHostRecord, AgentWebclientHostConfig } from "./webclient-host-types";
import { type ServiceDefinition } from "../../support/manifest/manifest-utils";
import { assertHostConfig, normalizeDesktopHosting } from "./webclient-host-config";
import { HOST } from "./webclient-host-policy";
import http from "node:http";
import { type Socket } from "node:net";
import { handleHttpRequest, handleUpgrade } from "./webclient-request-handler";

export const hosts = new Map<string, AgentWebclientHostRecord>();

export function isHostManagedAgentWebclientService(service: Pick<ServiceDefinition, "id" | "frontend">) {
  return service.id === "agent-webclient" && service.frontend.hostManaged === true;
}

export function getAgentWebclientHostState(serviceId = "agent-webclient") {
  const record = hosts.get(serviceId);
  return record
    ? {
        running: true,
        port: record.port,
        webUrl: record.webUrl,
        pid: process.pid
      }
    : {
        running: false,
        port: null,
        webUrl: "",
        pid: null
      };
}

export async function startAgentWebclientHost(config: AgentWebclientHostConfig) {
  const serviceId = config.service.id;
  const current = hosts.get(serviceId);
  if (current && current.port === config.port) {
    return getAgentWebclientHostState(serviceId);
  }
  if (current) {
    await stopAgentWebclientHost(serviceId);
  }

  const { frontendDist, indexFile } = assertHostConfig(config);
  const logger = config.logger || console;
  const hosting = normalizeDesktopHosting(config.service);
  const webUrl = `http://${HOST}:${config.port}/`;
  const record: AgentWebclientHostRecord = {
    serviceId,
    server: http.createServer(),
    port: config.port,
    webUrl,
    frontendDist,
    indexFile,
    frontendSpa: config.service.frontend.spa !== false,
    layout: config.layout,
    env: config.env,
    envOverrides: config.envOverrides ?? new Map<string, string>(),
    hosting,
    logger,
    issueAccessToken: config.issueAccessToken,
    sockets: new Set()
  };

  record.server.on("connection", (socket: Socket) => {
    record.sockets.add(socket);
    socket.on("close", () => {
      record.sockets.delete(socket);
    });
  });
  record.server.on("request", (req, res) => {
    handleHttpRequest(record, req, res).catch((error) => {
      logger.error?.(`[agent-webclient-host] request failed: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      }
      res.end("internal server error");
    });
  });
  record.server.on("upgrade", (req, socket, head) => {
    handleUpgrade(record, req, socket as Socket, head).catch(() => {
      socket.destroy();
    });
  });

  await new Promise<void>((resolve, reject) => {
    const handleError = (error: Error) => {
      record.server.removeListener("listening", handleListening);
      reject(error);
    };
    const handleListening = () => {
      record.server.removeListener("error", handleError);
      resolve();
    };
    record.server.once("error", handleError);
    record.server.once("listening", handleListening);
    record.server.listen(config.port, HOST);
  });

  hosts.set(serviceId, record);
  logger.log?.(`[agent-webclient-host] listening on ${webUrl}`);
  return getAgentWebclientHostState(serviceId);
}

export function stopAgentWebclientHost(serviceId = "agent-webclient") {
  const record = hosts.get(serviceId);
  if (!record) {
    return Promise.resolve(getAgentWebclientHostState(serviceId));
  }
  hosts.delete(serviceId);
  return new Promise<ReturnType<typeof getAgentWebclientHostState>>((resolve) => {
    record.server.close(() => {
      resolve(getAgentWebclientHostState(serviceId));
    });
    for (const socket of record.sockets) {
      socket.destroy();
    }
  });
}
