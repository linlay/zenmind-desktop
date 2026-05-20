import { useEffect } from "react";
import type { AssistantWorkerOpenRequest } from "../../../shared/contracts";
import { PluginPage } from "../../pages/plugin/PluginPage";

const AGENT_WEBCLIENT_COPILOT_PATH = "/copilot";

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
  const targetAgentKey = openRequest?.agentKey ?? openRequest?.workerKey ?? resolvedAgentKey;

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
        key={`agent-webclient-copilot:${targetAgentKey}`}
        active={open}
        embedPath={AGENT_WEBCLIENT_COPILOT_PATH}
        hostTheme={hostTheme}
        pluginId="agent-webclient"
        surfaceLabel="助手"
        skipContextRegistration
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
