import type { ServiceLogReadOptions, ServiceLogReadResult } from "./services";

export type WebKind = "website" | "webapp";
export type WebEntryKey = `website:${string}` | `webapp:${string}`;
export type WebappRuntimeStatus = "stopped" | "starting" | "running" | "error";
export type WebappLogTarget = "main" | "error";
export type WebappSourceKind = "market" | "local" | "plugin" | "bundled";

export interface WebappFrontendConfig {
  root: string;
  index: string;
  spa: boolean;
  apiPrefix: string;
}

export interface WebappBackendConfig {
  runtime: "node";
  entry: string;
  args: string[];
  env: Record<string, string>;
  port: number;
  healthPath: string;
}

export interface WebEntryBase {
  id: string;
  entryKey: WebEntryKey;
  label: string;
  kind: WebKind;
  agentKey?: string;
  createdAt: number;
  updatedAt: number;
}

export interface WebsiteEntry extends WebEntryBase {
  kind: "website";
  entryKey: `website:${string}`;
  url: string;
}

export interface WebappEntry extends WebEntryBase {
  kind: "webapp";
  entryKey: `webapp:${string}`;
  frontend: WebappFrontendConfig;
  backend?: WebappBackendConfig;
  sourceKind?: WebappSourceKind;
  sourceLabel?: string;
  sourceOwnerId?: string;
  installPath?: string;
  removable?: boolean;
}

export type WebEntry = WebsiteEntry | WebappEntry;

export interface WebappRuntimeState {
  id: string;
  entryKey: `webapp:${string}`;
  kind: "webapp";
  status: WebappRuntimeStatus;
  webUrl: string;
  backendUrl: string;
  frontendPort: number | null;
  backendPort: number | null;
  pid: number | null;
  message: string;
  startedAt?: string;
  updatedAt: string;
}

export interface WebListResult {
  ok: boolean;
  items: WebEntry[];
  message: string;
}

export interface WebsChangedEvent {
  changedAt: string;
}

export type WebsChangedListener = (event: WebsChangedEvent) => void;

export interface WebsiteInput {
  id?: string;
  label?: string;
  url: string;
  agentKey?: string;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface WebsiteUpdateInput {
  label?: string;
  url?: string;
  agentKey?: string;
}

export interface WebsiteInputIssue {
  field: string;
  message: string;
  expected?: string;
  received?: string;
}

export interface WebsiteItemsResult {
  ok: boolean;
  items: WebsiteEntry[];
  message: string;
}

export interface WebsiteResult {
  ok: boolean;
  item: WebsiteEntry | null;
  items: WebsiteEntry[];
  message: string;
  issues?: WebsiteInputIssue[];
}

export interface WebsiteDeleteResult {
  ok: boolean;
  items: WebsiteEntry[];
  message: string;
}

export interface WebsiteTransferResult {
  ok: boolean;
  items: WebsiteEntry[];
  path: string;
  message: string;
}

export interface WebappUpdateInput {
  label?: string;
  agentKey?: string;
}

export interface WebappItemsResult {
  ok: boolean;
  items: WebappEntry[];
  message: string;
}

export interface WebappResult {
  ok: boolean;
  item: WebappEntry | null;
  items: WebappEntry[];
  message: string;
}

export interface WebappImportResult {
  ok: boolean;
  item: WebappEntry | null;
  items: WebEntry[];
  path: string;
  message: string;
  installPath?: string;
}

export interface WebappDeleteResult {
  ok: boolean;
  item: WebappEntry | null;
  items: WebappEntry[];
  message: string;
}

export interface WebappStatusResult {
  ok: boolean;
  state: WebappRuntimeState | null;
  message: string;
}

export interface WebappCommandResult {
  ok: boolean;
  item: WebappEntry | null;
  state: WebappRuntimeState | null;
  message: string;
}

export type WebappPublishProvider = "tunnel";
export type WebappPublishStatus = "not-configured" | "ready" | "publishing" | "published" | "unpublished" | "error";

export interface WebappPublishInfo {
  provider: WebappPublishProvider;
  configured: boolean;
  signedIn: boolean;
  tunnelEnabled: boolean;
  tunnelConnected: boolean;
  deviceId: string;
  relayUrl: string;
}

export interface WebappPublishState {
  id: string;
  provider: WebappPublishProvider;
  status: WebappPublishStatus;
  name: string;
  routeId: string;
  publicHost: string;
  url: string;
  targetUrl: string;
  active: boolean;
  message: string;
  updatedAt: string;
}

export interface WebappPublishInfoResult {
  ok: boolean;
  info: WebappPublishInfo;
  state: WebappPublishState | null;
  message: string;
}

export interface WebappPublishResult {
  ok: boolean;
  info: WebappPublishInfo;
  state: WebappPublishState;
  message: string;
}

export interface WebappLogReadResult extends ServiceLogReadResult {}
export interface WebappLogReadOptions extends ServiceLogReadOptions {}
