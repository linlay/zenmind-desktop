import fs from "node:fs";
import path from "node:path";
import type { AssistantBootstrapState } from "../../../shared/contracts";
import { resolveRuntimeRoot } from "../../env-bootstrap";

type AppPathReader = {
  getPath(name: "home"): string;
};

export const ASSISTANT_OWNER_PROFILE_RELATIVE_PATH = ["owner", "OWNER.md"] as const;

function pathApiForPlatform(platform: NodeJS.Platform) {
  return platform === "win32" ? path.win32 : path;
}

export function resolveAssistantOwnerProfilePath(
  app: AppPathReader,
  platform: NodeJS.Platform = process.platform,
) {
  return pathApiForPlatform(platform).join(
    resolveRuntimeRoot(app, platform),
    ...ASSISTANT_OWNER_PROFILE_RELATIVE_PATH,
  );
}

export function getAssistantBootstrapState(
  app: AppPathReader,
  platform: NodeJS.Platform = process.platform,
): AssistantBootstrapState {
  const ownerProfilePath = resolveAssistantOwnerProfilePath(app, platform);
  try {
    return { ownerProfileExists: fs.statSync(ownerProfilePath).isFile() };
  } catch {
    return { ownerProfileExists: false };
  }
}

export type AssistantBootstrapStateMonitor = {
  start(): void;
  stop(): void;
};

export function createAssistantBootstrapStateMonitor(options: {
  app: AppPathReader;
  platform?: NodeJS.Platform;
  intervalMs?: number;
  onChange: (state: AssistantBootstrapState) => void;
}): AssistantBootstrapStateMonitor {
  const platform = options.platform ?? process.platform;
  const ownerProfilePath = resolveAssistantOwnerProfilePath(options.app, platform);
  let started = false;
  let currentState: AssistantBootstrapState | null = null;

  const refresh = () => {
    const nextState = getAssistantBootstrapState(options.app, platform);
    if (currentState?.ownerProfileExists === nextState.ownerProfileExists) {
      return;
    }
    currentState = nextState;
    options.onChange(nextState);
  };

  return {
    start() {
      if (started) {
        return;
      }
      started = true;
      refresh();
      fs.watchFile(ownerProfilePath, {
        persistent: false,
        interval: options.intervalMs ?? 1_000,
      }, refresh);
    },
    stop() {
      if (!started) {
        return;
      }
      started = false;
      fs.unwatchFile(ownerProfilePath, refresh);
    },
  };
}
