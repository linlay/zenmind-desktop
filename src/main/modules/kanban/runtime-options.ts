import type { App } from "electron";
import type {
  AssistantStartRunRequest,
  AssistantStartRunResult,
  DesktopPetAgentOption
} from "../../../shared/contracts";

export type AgentPlatformCaller<TApp> = <T = unknown>(
  app: TApp,
  path: string,
  options?: {
    method?: string;
    body?: unknown;
  }
) => Promise<T>;

export type AssistantBridgeLike = {
  listAgents: () => Promise<DesktopPetAgentOption[]>;
  startRun: (request: AssistantStartRunRequest) => Promise<AssistantStartRunResult>;
  stopRun?: (runId: string) => Promise<{ ok: boolean; message?: string }>;
  getChat?: (chatId: string) => Promise<{
    messages?: Array<{ runId?: string; role?: string; content?: string }>;
    events?: Array<{ runId?: string; seq?: number; type?: string; status?: string; message?: string; error?: string }>;
  } | null>;
};

export type KanbanRuntimeOptions = {
  app: App;
  assistantBridge: AssistantBridgeLike;
  callAgentPlatform: AgentPlatformCaller<App>;
  listLocalAgents?: () => DesktopPetAgentOption[];
  canUseDesktopSsoCredentials?: () => boolean;
  onChanged?: () => void;
  onDebug?: (message: string) => void;
};
