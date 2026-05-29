import { useEffect } from "react";
import type { AssistantWorkerOpenRequest } from "../../../shared/contracts";
import { PluginPage } from "../../pages/plugin/PluginPage";

const AGENT_WEBCLIENT_COPILOT_PATH = "/copilot";

function normalizeAgentKey(value = "") {
  const trimmed = value.trim();
  return trimmed.startsWith("agent:") ? trimmed.slice("agent:".length).trim() : trimmed;
}

function resolveTargetAgentKey(openRequest: AssistantWorkerOpenRequest | null, fallbackAgentKey = "") {
  return normalizeAgentKey(openRequest?.agentKey ?? openRequest?.workerKey ?? fallbackAgentKey);
}

function buildAgentWebclientCopilotPath(openRequest: AssistantWorkerOpenRequest | null, fallbackAgentKey = "") {
  const agentKey = resolveTargetAgentKey(openRequest, fallbackAgentKey);
  const chatId = openRequest?.chatId?.trim() ?? "";
  if (!agentKey) {
    if (!chatId) {
      return AGENT_WEBCLIENT_COPILOT_PATH;
    }
    const params = new URLSearchParams();
    params.set("chatId", chatId);
    return `${AGENT_WEBCLIENT_COPILOT_PATH}?${params.toString()}`;
  }

  if (!chatId) {
    return `${AGENT_WEBCLIENT_COPILOT_PATH}/${encodeURIComponent(agentKey)}`;
  }

  const params = new URLSearchParams();
  params.set("chatId", chatId);
  return `${AGENT_WEBCLIENT_COPILOT_PATH}/${encodeURIComponent(agentKey)}?${params.toString()}`;
}

export function AgentWebclientCopilotDock({
  open,
  hostTheme,
  nativeDialogVisible,
  openRequest,
  resolvedAgentKey,
  onClose,
  onRunningRunIdChange
}: {
  open: boolean;
  hostTheme: "light" | "dark";
  nativeDialogVisible: boolean;
  openRequest: AssistantWorkerOpenRequest | null;
  resolvedAgentKey: string;
  onClose: () => void;
  onRunningRunIdChange: (runId: string | null) => void;
}) {
  const targetAgentKey = resolveTargetAgentKey(openRequest, resolvedAgentKey);
  const targetEmbedPath = buildAgentWebclientCopilotPath(openRequest, resolvedAgentKey);

  useEffect(() => {
    if (!open) {
      onRunningRunIdChange(null);
    }
  }, [onRunningRunIdChange, open]);

  return (
    <aside
      className={[
        "agent-webclient-copilot-dock",
        open ? "is-open" : "",
        nativeDialogVisible ? "is-native-dialog-open" : ""
      ].filter(Boolean).join(" ")}
      aria-hidden={!open}
      data-open-chat-id={openRequest?.chatId ?? ""}
      data-open-agent-key={targetAgentKey}
    >
      <PluginPage
        key={`agent-webclient-copilot:${targetEmbedPath}`}
        active={open}
        embedPath={targetEmbedPath}
        hostTheme={hostTheme}
        pluginId="agent-webclient"
        surfaceLabel="助手"
        skipContextRegistration
        loadInitialEmbeddedUrlDirectly
        suppressInitialLoadingCopy
      />
      <button
        type="button"
        className="agent-webclient-copilot-close"
        onClick={onClose}
        aria-label="关闭助手"
        title="关闭"
      >
        <span aria-hidden="true" />
      </button>
    </aside>
  );
}
