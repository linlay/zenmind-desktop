import type { BrowserUsePage, BrowserUseState } from "../../../shared/browser-use";

/** Private Main transport; drain resolves only after real replies or transport close. */
export interface BrowserWorkerClient {
  request(method: string, params?: Record<string, unknown>, pageId?: string, signal?: AbortSignal): Promise<unknown>;
  drain?(): Promise<void>;
  disconnect(): Promise<void>;
  kill(): void;
}
export type ChromeWorkspacePage = BrowserUsePage & { pageId: string };
export type ChromeWorkspace = {
  id: string;
  shared: boolean;
  generation: number;
  activityRevision: number;
  awcpLeaseSequence: number;
  lastUsed: number;
  connection: BrowserUseState["connection"];
  client?: BrowserWorkerClient;
  pages: Map<string, ChromeWorkspacePage>;
  selectedSurfaceId?: string;
  connectionName: string;
  connecting?: { promise: Promise<void>; abort: AbortController };
  owner?: { chatId: string; runId: string; draining: boolean };
  drain?: Promise<void>;
  error?: BrowserUseState["error"];
};
