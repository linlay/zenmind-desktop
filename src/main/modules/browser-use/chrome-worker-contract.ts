import type { BrowserObservedDialog, BrowserObservedDownload, BrowserObservedElement, BrowserObservedFileChooser } from "../../../shared/browser-use";

export type ChromeWorkerMethod = "connect" | "list" | "state" | "open" | "navigate" | "back" | "reload" | "activate" | "close" | "observe" | "click" | "interact" | "dialog" | "upload" | "downloads" | "screenshot" | "disconnect" | "cancel"
  | "awcp-manual" | "awcp-invoke" | "awcp-release-run" | "awcp-refresh" | "cancel-request";

/** Main-only connect options; never accepted from model-authored Surface parameters. */
export type ChromeWorkerConnectParams = { channel?: "chrome"; clientName?: string; profileDirName?: string; extensionToken?: string };
export type ChromeWorkerAwcpParams = { requestId: string; runId: string; payload: Record<string, unknown>; expectedUrl: string; bridgeScript: string };

export type ChromeWorkerRequest = {
  id: string;
  method: ChromeWorkerMethod;
  params?: Record<string, unknown>;
  pageId?: string;
};

export type ChromeWorkerReply = {
  id: string;
  result?: unknown;
  error?: { code: string; message: string; statusCode?: number; details?: Record<string, unknown> };
};

export type ChromeWorkerPage = { pageId: string; url: string; title: string; active?: boolean; isLoading?: boolean };
export type ChromeWorkerState = { connected: boolean; pages: ChromeWorkerPage[] };
export type ChromeWorkerElement = BrowserObservedElement;
export type ChromeWorkerObservation = {
  observationId: string;
  url: string;
  title: string;
  text: string;
  elements: ChromeWorkerElement[];
  truncated: boolean;
  dialogs?: BrowserObservedDialog[];
  fileChoosers?: BrowserObservedFileChooser[];
  downloads?: BrowserObservedDownload[];
  viewportOnly?: boolean;
};

export type ChromeWorkerActionObservation = {
  observation?: ChromeWorkerObservation;
  observationError?: { code: string; message: string };
};

export type ChromeWorkerModalState = {
  type: string;
  dialog?: import("playwright-core").Dialog;
  fileChooser?: import("playwright-core").FileChooser;
};

export interface ChromeWorkerController {
  browserContext: import("playwright-core").BrowserContext;
  list(): Promise<ChromeWorkerPage[]>;
  describe(tab: ChromeWorkerTab): Promise<ChromeWorkerPage>;
  open(url?: string): Promise<ChromeWorkerPage>;
  run<T>(pageId: string, operation: (tab: ChromeWorkerTab) => Promise<T>, options?: { downloadCapture?: boolean }): Promise<T>;
  tool(pageId: string, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<{ content?: Array<{ type: string; text?: string; data?: string }>; isError?: boolean }>;
  disconnect(): Promise<void>;
}

export interface ChromeWorkerTab {
  desktopPageId: string;
  page: import("playwright-core").Page;
  captureSnapshot(root?: undefined, depth?: number, boxes?: boolean, relativeTo?: string, ariaFormat?: string, webmcp?: boolean): Promise<{ ariaSnapshot: string; ariaSnapshotJSON?: unknown }>;
  targetLocator(params: { target: string }): Promise<{ locator: import("playwright-core").Locator }>;
  modalStates?(): ChromeWorkerModalState[];
  clearModalState?(state: ChromeWorkerModalState): void;
  /** Private adapter session restricted to the response-download Fetch/IO methods. */
  createDownloadSession?(): Promise<Pick<import("playwright-core").CDPSession, "send" | "on" | "off" | "detach">>;
}
