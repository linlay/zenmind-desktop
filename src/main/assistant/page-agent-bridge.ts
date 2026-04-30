import fs from "node:fs";
import path from "node:path";

export type PageAgentBridgeEvent = {
  seq?: number;
  type?: string;
  message?: string;
  data?: unknown;
  createdAt?: string;
};

export type PageAgentBridgeStartResult = {
  ok: true;
  runId: string;
};

export type PageAgentBridgeResult = {
  success?: boolean;
  data?: string;
  history?: unknown[];
};

export type PageAgentBridgeStatus = {
  ok: boolean;
  status?: "running" | "completed" | "error" | "stopped";
  result?: PageAgentBridgeResult | null;
  error?: string;
};

function isWindowsPlatform() {
  return process.platform === "win32";
}

function isMacPlatform() {
  return process.platform === "darwin";
}

export function resolvePageAgentBridgePath() {
  const bundledCandidate = path.join(__dirname, "page-agent-bridge.iife.js");
  if (fs.existsSync(bundledCandidate)) {
    return bundledCandidate;
  }

  const projectCandidate = path.resolve(process.cwd(), "dist-electron", "main", "assistant", "page-agent-bridge.iife.js");
  if (fs.existsSync(projectCandidate)) {
    return projectCandidate;
  }

  if (isWindowsPlatform()) {
    return path.win32.normalize(projectCandidate);
  }
  if (isMacPlatform()) {
    return path.posix.normalize(projectCandidate);
  }
  return projectCandidate;
}

export function readPageAgentBridgeSource() {
  const bridgePath = resolvePageAgentBridgePath();
  if (!fs.existsSync(bridgePath)) {
    throw new Error(`PageAgent bridge 未构建：${bridgePath}`);
  }
  return fs.readFileSync(bridgePath, "utf8");
}

export function buildPageAgentBridgeInstallExpression(source: string) {
  return `(() => {
    if (!window.__ZENMIND_PAGE_AGENT_BRIDGE__) {
      ${source}
    }
    return Boolean(window.__ZENMIND_PAGE_AGENT_BRIDGE__);
  })()`;
}

export function buildPageAgentBridgeCallExpression<TInput>(method: string, input: TInput) {
  return `(() => {
    const bridge = window.__ZENMIND_PAGE_AGENT_BRIDGE__;
    if (!bridge || typeof bridge[${JSON.stringify(method)}] !== "function") {
      throw new Error("PageAgent bridge is not installed.");
    }
    return bridge[${JSON.stringify(method)}](...${JSON.stringify(Array.isArray(input) ? input : [input])});
  })()`;
}

export function compactPageAgentHistory(history: unknown[] | undefined, limit = 24) {
  if (!Array.isArray(history)) {
    return [];
  }
  return history.slice(-limit).map((item) => {
    if (!item || typeof item !== "object") {
      return item;
    }
    const event = item as Record<string, unknown>;
    if (event.type === "step") {
      const action = event.action && typeof event.action === "object" ? event.action as Record<string, unknown> : {};
      return {
        type: event.type,
        stepIndex: event.stepIndex,
        reflection: event.reflection,
        action: {
          name: action.name,
          input: action.input,
          output: typeof action.output === "string" && action.output.length > 2000
            ? `${action.output.slice(0, 2000)}...[truncated ${action.output.length - 2000} chars]`
            : action.output
        }
      };
    }
    return event;
  });
}

export const __testInternals = {
  isWindowsPlatform,
  isMacPlatform
};
