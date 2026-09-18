import type { SurfaceIdentity } from "../../../../shared/surface-identity";
import type { EmbeddedCdpSurfaceKind } from "../../../../shared/embedded-cdp";

/** Trusted host registration. Its legacy guest surfaceId is a Container identity
 * at the webpage automation boundary; public page IDs are derived per tab.
 */
export type EmbeddedCdpContainer = SurfaceIdentity & {
  id: string;
  targetGeneration?: string;
  label: string;
  url: string;
  kind?: "webview";
  active?: boolean;
  currentUrl?: string;
  title?: string;
  webContentsId?: number;
  copilotAgentKey?: string;
  surfaceRoute?: string;
  embedPath?: string;
  surfaceKind: EmbeddedCdpSurfaceKind;
  open: boolean;
  tabs?: EmbeddedCdpSurfaceTab[];
  activeTabId?: string | null;
  ownerChatId?: string;
};

export type EmbeddedCdpSurfaceTab = {
  tabId: string;
  currentUrl: string;
  title: string;
  webContentsId: number;
  faviconUrl?: string;
  canGoBack?: boolean;
  canGoForward?: boolean;
  isLoading?: boolean;
};

