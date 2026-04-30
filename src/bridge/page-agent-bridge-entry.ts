import { PageAgentCore } from "@page-agent/core";
import { PageController } from "@page-agent/page-controller";

type BridgeEvent = {
  seq: number;
  type: "status" | "activity" | "history" | "result" | "error";
  message: string;
  data?: unknown;
  createdAt: string;
};

type BridgeRun = {
  agent: PageAgentCore;
  events: BridgeEvent[];
  result: unknown;
  status: "running" | "completed" | "error" | "stopped";
  seq: number;
};

type StartInput = {
  task: string;
  baseURL: string;
  model: string;
  token: string;
  allowSensitive?: boolean;
  maxSteps?: number;
  systemInstruction?: string;
};

const globalWindow = window as Window & {
  __ZENMIND_PAGE_AGENT_BRIDGE__?: {
    start: (input: StartInput) => Promise<{ ok: true; runId: string }>;
    drainEvents: (runId: string) => BridgeEvent[];
    getResult: (runId: string) => { ok: boolean; status?: string; result?: unknown; error?: string };
    stop: (runId: string) => { ok: boolean };
    cleanup: (runId: string) => { ok: boolean };
  };
};

const runs = new Map<string, BridgeRun>();

function compact(value: unknown, maxLength = 3000) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) {
    return "";
  }
  return text.length > maxLength ? `${text.slice(0, maxLength)}...[truncated ${text.length - maxLength} chars]` : text;
}

function pushEvent(run: BridgeRun, event: Omit<BridgeEvent, "seq" | "createdAt">) {
  run.seq += 1;
  run.events.push({
    seq: run.seq,
    createdAt: new Date().toISOString(),
    ...event
  });
  if (run.events.length > 200) {
    run.events.splice(0, run.events.length - 200);
  }
}

function activityMessage(activity: unknown) {
  const item = activity && typeof activity === "object" ? activity as Record<string, unknown> : {};
  switch (item.type) {
    case "thinking":
      return "PageAgent 正在分析页面。";
    case "executing":
      return typeof item.tool === "string" ? `PageAgent 正在执行 ${item.tool}。` : "PageAgent 正在执行页面操作。";
    case "executed":
      return typeof item.tool === "string" ? `PageAgent 已执行 ${item.tool}。` : "PageAgent 已完成一步页面操作。";
    case "retrying":
      return "PageAgent 正在重试模型请求。";
    case "error":
      return typeof item.message === "string" ? item.message : "PageAgent 执行遇到错误。";
    default:
      return "PageAgent 状态已更新。";
  }
}

function systemInstruction(allowSensitive: boolean, custom?: string) {
  return [
    "你正在 ZenMind Desktop 内嵌网页中执行用户交给右侧助手的浏览器任务。",
    "不要展示或打开 PageAgent 自带面板；只完成用户明确要求的网页操作。",
    "默认用中文总结结果。",
    allowSensitive
      ? "用户已确认本次任务中的敏感操作；只允许执行与用户请求直接相关的敏感动作，不要扩大范围。"
      : "不要执行删除、支付、授权、登录、注册、保存、最终提交、提交订单等敏感动作；如任务需要这些动作，请停止在敏感动作前并说明需要用户确认。",
    custom || ""
  ].filter(Boolean).join("\n");
}

async function start(input: StartInput) {
  const runId = `page_agent_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const pageController = new PageController({
    enableMask: false,
    viewportExpansion: 600
  });
  const agent = new PageAgentCore({
    pageController,
    baseURL: input.baseURL,
    apiKey: input.token,
    model: input.model,
    language: "zh-CN",
    maxSteps: Math.min(Math.max(Number(input.maxSteps) || 20, 1), 40),
    stepDelay: 0.25,
    experimentalScriptExecutionTool: false,
    experimentalLlmsTxt: false,
    instructions: {
      system: systemInstruction(Boolean(input.allowSensitive), input.systemInstruction)
    },
    transformPageContent: (content) => compact(content, 20000)
  });
  const run: BridgeRun = {
    agent,
    events: [],
    result: null,
    status: "running",
    seq: 0
  };
  runs.set(runId, run);

  agent.addEventListener("statuschange", () => {
    pushEvent(run, {
      type: "status",
      message: `PageAgent 状态：${agent.status}`,
      data: { status: agent.status }
    });
  });
  agent.addEventListener("activity", (event) => {
    const activity = event instanceof CustomEvent ? event.detail : null;
    pushEvent(run, {
      type: "activity",
      message: activityMessage(activity),
      data: activity
    });
  });
  agent.addEventListener("historychange", () => {
    const latest = agent.history.at(-1);
    if (!latest) {
      return;
    }
    pushEvent(run, {
      type: "history",
      message: latest.type === "step" ? `PageAgent 完成第 ${latest.stepIndex + 1} 步。` : `PageAgent 记录：${latest.type}`,
      data: latest
    });
  });

  void agent.execute(input.task).then((result) => {
    run.result = result;
    run.status = result.success ? "completed" : "error";
    pushEvent(run, {
      type: "result",
      message: result.success ? "PageAgent 任务完成。" : "PageAgent 任务未完成。",
      data: result
    });
  }).catch((error) => {
    run.result = {
      success: false,
      data: error instanceof Error ? error.message : String(error),
      history: agent.history
    };
    run.status = "error";
    pushEvent(run, {
      type: "error",
      message: error instanceof Error ? error.message : String(error),
      data: run.result
    });
  });

  return { ok: true as const, runId };
}

function drainEvents(runId: string) {
  const run = runs.get(runId);
  if (!run) {
    return [];
  }
  return run.events.splice(0, run.events.length);
}

function getResult(runId: string) {
  const run = runs.get(runId);
  if (!run) {
    return { ok: false, error: "page_agent_run_not_found" };
  }
  return {
    ok: true,
    status: run.status,
    result: run.result
  };
}

function stop(runId: string) {
  const run = runs.get(runId);
  if (!run) {
    return { ok: false };
  }
  run.status = "stopped";
  run.agent.stop();
  pushEvent(run, {
    type: "status",
    message: "PageAgent 已停止。",
    data: { status: "stopped" }
  });
  return { ok: true };
}

function cleanup(runId: string) {
  const run = runs.get(runId);
  if (!run) {
    return { ok: false };
  }
  run.agent.dispose();
  runs.delete(runId);
  return { ok: true };
}

globalWindow.__ZENMIND_PAGE_AGENT_BRIDGE__ = {
  start,
  drainEvents,
  getResult,
  stop,
  cleanup
};
