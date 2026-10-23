/** Browser automation uses opaque page identities; browser profiles stay in Main. */
export type BrowserUseBackend = "workpanel" | "chrome";

export type BrowserObservedOption = {
  label: string;
  value: string;
  selected: boolean;
  disabled: boolean;
};

export type BrowserObservedDialog = {
  dialogId: string;
  type: "alert" | "confirm" | "prompt" | "beforeunload";
  message: string;
};

export type BrowserObservedFileChooser = { chooserId: string; multiple: boolean };
export type BrowserObservedDownload = {
  downloadId: string;
  fileName: string;
  status: "pending" | "complete" | "failed";
  sizeBytes?: number;
  error?: string;
};

export type BrowserObservedElement = {
  ref: string;
  role: string;
  name: string;
  tag: string;
  value?: string;
  checked?: boolean | "mixed";
  disabled?: boolean;
  expanded?: boolean;
  selected?: boolean;
  pressed?: boolean | "mixed";
  invalid?: boolean | "grammar" | "spelling";
  active?: boolean;
  level?: number;
  placeholder?: string;
  required?: boolean;
  readOnly?: boolean;
  validationMessage?: string;
  fileCount?: number;
  href?: string;
  frameUrl?: string;
  /** Native select choices; values are exact strings usable by the select action. */
  options?: BrowserObservedOption[];
  multiple?: boolean;
  optionsTruncated?: boolean;
};

export type BrowserObservation = {
  surfaceId: string;
  provider: BrowserUseBackend;
  observationId: string;
  url: string;
  title: string;
  text: string;
  elements: BrowserObservedElement[];
  truncated: boolean;
  dialogs?: BrowserObservedDialog[];
  fileChoosers?: BrowserObservedFileChooser[];
  downloads?: BrowserObservedDownload[];
  viewportOnly?: boolean;
};

export type BrowserUsePage = {
  surfaceId: string;
  provider: BrowserUseBackend;
  title: string;
  url: string;
  active: boolean;
  isLoading: boolean;
};

export type BrowserUseState = {
  chatId: string;
  backend: BrowserUseBackend;
  connection: "disconnected" | "connecting" | "connected" | "error";
  pages: BrowserUsePage[];
  activeRunIds: string[];
  error?: { code: string; message: string };
  connectionName?: string;
  selectedSurfaceId?: string;
  connectionRequest?: { id: string; runId: string; reason: "connect" | "new_run" };
  /** Main owns the connection; these identities never authorize renderer actions. */
  workspaceId?: string;
  workspaceShared?: boolean;
  workspaceOwner?: { chatId: string; runId: string; draining: boolean };
};

export type BrowserUsePreferences = {
  defaultBackend: BrowserUseBackend;
  rememberChromeConnection: boolean;
  hasSavedAuthorization: boolean;
  secureStorageAvailable: boolean;
};
export type BrowserUseSettingsState = BrowserUsePreferences & { connectedChats: number; activeRuns: number };
export type BrowserUseSettingsRequest =
  | { action: "get" | "forget" | "install-extension" }
  | { action: "save"; defaultBackend: BrowserUseBackend; rememberChromeConnection: boolean; extensionToken?: string };
export type BrowserUseSettingsResult = { ok: true; state: BrowserUseSettingsState } |
  { ok: false; error: { code: string; message: string } };

export type BrowserUseResult = { ok: true; state: BrowserUseState } |
  { ok: false; error: { code: string; message: string } };

export const BROWSER_USE_CHANNEL = "browserUse.control";
export const BROWSER_USE_CHANGED = "browserUse.changed";
export const BROWSER_USE_SETTINGS_CHANNEL = "browserUse.settings";
export const BROWSER_USE_SETTINGS_CHANGED = "browserUse.settingsChanged";
export const CHROME_BROWSER_EXTENSION_URL =
  "https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm";

export type BrowserUseControlRequest =
  | { action: "state" | "disconnect" | "takeover"; chatId: string }
  | { action: "connect"; chatId: string; interactive?: boolean }
  | { action: "select"; chatId: string; backend: BrowserUseBackend }
  | { action: "activate"; chatId: string; surfaceId: string }
  | { action: "install-extension"; chatId: string };

export interface BrowserUseApi {
  control(request: BrowserUseControlRequest): Promise<BrowserUseResult>;
  onChanged(listener: (state: BrowserUseState) => void): () => void;
  settings(request: BrowserUseSettingsRequest): Promise<BrowserUseSettingsResult>;
  onSettingsChanged(listener: (state: BrowserUseSettingsState) => void): () => void;
}
