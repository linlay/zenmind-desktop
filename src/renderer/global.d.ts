import type { DesktopApi } from "../shared/contracts";

declare global {
  interface Window {
    electronAPI: DesktopApi;
  }
}

export {};
