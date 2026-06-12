import type { ServiceLogReadOptions, ServiceLogReadResult } from "./services";

export type WebsiteKind = "external" | "local-app";
export type WebsiteRuntimeStatus = "stopped" | "starting" | "running" | "error";
export type WebsiteLogTarget = "main" | "error";

export interface WebsiteFrontendConfig {
  root: string;
  index: string;
  spa: boolean;
  apiPrefix: string;
}

export interface WebsiteBackendConfig {
  runtime: "node";
  entry: string;
  args: string[];
  env: Record<string, string>;
  port: number;
  healthPath: string;
}

export interface WebsiteEntryBase {
  id: string;
  label: string;
  kind: WebsiteKind;
  agentKey?: string;
  createdAt: number;
  updatedAt: number;
}

export interface WebsiteExternalEntry extends WebsiteEntryBase {
  kind: "external";
  url: string;
}

export interface WebsiteLocalAppEntry extends WebsiteEntryBase {
  kind: "local-app";
  frontend: WebsiteFrontendConfig;
  backend: WebsiteBackendConfig;
}

export type WebsiteListItem = WebsiteExternalEntry | WebsiteLocalAppEntry;

export interface WebsiteRuntimeState {
  id: string;
  kind: "local-app";
  status: WebsiteRuntimeStatus;
  webUrl: string;
  backendUrl: string;
  frontendPort: number | null;
  backendPort: number | null;
  pid: number | null;
  message: string;
  startedAt?: string;
  updatedAt: string;
}

export interface WebsiteListResult {
  ok: boolean;
  items: WebsiteListItem[];
  message: string;
}

export interface WebsiteStatusResult {
  ok: boolean;
  state: WebsiteRuntimeState | null;
  message: string;
}

export interface WebsiteCommandResult {
  ok: boolean;
  item: WebsiteListItem | null;
  state: WebsiteRuntimeState | null;
  message: string;
}

export interface WebsiteLogReadResult extends ServiceLogReadResult {}
export interface WebsiteLogReadOptions extends ServiceLogReadOptions {}
