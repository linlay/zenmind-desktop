import type { DesktopApi } from "../shared/contracts";
import type { AgentWebClientHost } from "./assistant-webclient/lib/host";

declare global {
  interface Window {
    electronAPI: DesktopApi;
    __ZENMIND_AGENT_HOST?: AgentWebClientHost;
  }
}

export {};
