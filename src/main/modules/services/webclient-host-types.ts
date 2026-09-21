import { type AgentAuthRefreshReason, type AgentAuthIssueResult, type ManifestDesktopProxyRoute } from "../../../shared/contracts";
import { type ServiceDefinition } from "../../support/manifest/manifest-utils";
import { type ServiceLayout } from "./manager/layout";
import http from "node:http";
import { type Socket } from "node:net";

export type Logger = Pick<typeof console, "error" | "warn" | "log">;

export type IssueAccessToken = (reason: AgentAuthRefreshReason) => Promise<AgentAuthIssueResult>;

export type HostManagedDesktopHosting = {
  runtimeConfigPath: string;
  runtimeConfigEnvKeys: string[];
  spaRoutePrefixes: string[];
  proxyRoutes: ManifestDesktopProxyRoute[];
};

export type AgentWebclientHostConfig = {
  service: ServiceDefinition;
  layout: ServiceLayout;
  env: Map<string, string>;
  envOverrides?: Map<string, string>;
  port: number;
  logger?: Logger;
  issueAccessToken?: IssueAccessToken;
};

export type AgentWebclientHostRecord = {
  serviceId: string;
  server: http.Server;
  port: number;
  webUrl: string;
  frontendDist: string;
  indexFile: string;
  frontendSpa: boolean;
  layout: ServiceLayout;
  env: Map<string, string>;
  envOverrides: Map<string, string>;
  hosting: HostManagedDesktopHosting;
  logger: Logger;
  issueAccessToken?: IssueAccessToken;
  sockets: Set<Socket>;
};

export type FrontendRequestResolution =
  | { type: "file"; filePath: string }
  | { type: "notFound" };
