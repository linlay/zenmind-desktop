import type { BrowserObservedDialog, BrowserObservedDownload, BrowserObservedElement, BrowserObservedFileChooser } from "../../../shared/browser-use";

export type ChromeWorkerMethod = "connect" | "list" | "state" | "open" | "navigate" | "back" | "reload" | "activate" | "close" | "observe" | "click" | "interact" | "dialog" | "upload" | "downloads" | "screenshot" | "disconnect" | "cancel"
  | "awcp-manual" | "awcp-invoke" | "awcp-release-run" | "awcp-refresh" | "cancel-request" | "release-transfers";

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
  run<T>(pageId: string, operation: (tab: ChromeWorkerTab) => Promise<T>): Promise<T>;
  disconnect(): Promise<void>;
}

export interface ChromeWorkerTab {
  desktopPageId: string;
  page: import("playwright-core").Page;
  captureSnapshot(root?: undefined, depth?: number, boxes?: boolean, relativeTo?: string, ariaFormat?: string, webmcp?: boolean): Promise<{ ariaSnapshot: string; ariaSnapshotJSON?: unknown }>;
  targetLocator(params: { target: string }): Promise<{ locator: import("playwright-core").Locator }>;
  modalStates?(): ChromeWorkerModalState[];
  clearModalState?(state: ChromeWorkerModalState): void;
  /** Private adapter session restricted to copying and continuing one authorized response. */
  createDownloadSession?(): Promise<Pick<import("playwright-core").CDPSession, "send" | "on" | "off" | "detach">>;
}
