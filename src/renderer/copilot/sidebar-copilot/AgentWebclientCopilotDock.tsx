import { lazy, Suspense, useEffect, useState } from "react";
import type { AssistantWorkerOpenRequest } from "../../../shared/contracts";
import { createAgentWebclientCopilotPath } from "../../../shared/agent-webclient-routes";
import { decodeRoutePathSegment } from "../../../shared/route-path";
import { useI18n } from "../../i18n/useI18n";
import {
  normalizeCopilotEmbedPath,
  readCopilotChatId
} from "./copilotDockSession";

const PluginPage = lazy(() =>
  import("../../pages/plugin/PluginPage").then((module) => ({ default: module.PluginPage }))
);

const AGENT_WEBCLIENT_COPILOT_PATH = "/copilot";
const AGENT_WEBCLIENT_COPILOT_DOCK_SURFACE_ID = "agent-webclient-copilot-dock";

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

  const params = new URLSearchParams();
  if (chatId) {
    params.set("chatId", chatId);
  }
  return createAgentWebclientCopilotPath(agentKey, params);
}

function readCopilotAgentKeyFromPathname(pathname: string) {
  if (!pathname.startsWith(`${AGENT_WEBCLIENT_COPILOT_PATH}/`)) {
    return "";
  }

  const rawAgentKey = pathname.slice(AGENT_WEBCLIENT_COPILOT_PATH.length + 1).split("/")[0]?.trim() ?? "";
  if (!rawAgentKey) {
    return "";
  }

  return decodeRoutePathSegment(rawAgentKey) ?? "";
}

function readCopilotAgentKeyFromUrl(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  try {
    return readCopilotAgentKeyFromPathname(new URL(trimmed, "http://agent-webclient.local").pathname);
  } catch {
    return "";
  }
}

export function AgentWebclientCopilotDock({
  open,
  hostTheme,
  nativeDialogVisible,
  openRequest,
  restoredEmbedPath,
  resolvedAgentKey,
  onRunningRunIdChange,
  onSelectedAgentKeyChange,
  onCurrentEmbedPathChange
}: {
  open: boolean;
  hostTheme: "light" | "dark";
  nativeDialogVisible: boolean;
  openRequest: AssistantWorkerOpenRequest | null;
  restoredEmbedPath?: string;
  resolvedAgentKey: string;
  onRunningRunIdChange: (runId: string | null) => void;
  onSelectedAgentKeyChange?: (agentKey: string) => void;
  onCurrentEmbedPathChange?: (embedPath: string, agentKey: string, chatId?: string) => void;
}) {
  const { t } = useI18n();
  const [mounted, setMounted] = useState(open);
  const targetAgentKey = resolveTargetAgentKey(openRequest, resolvedAgentKey);
  const normalizedRestoredEmbedPath = normalizeCopilotEmbedPath(restoredEmbedPath ?? "");
  const targetEmbedPath = openRequest
    ? buildAgentWebclientCopilotPath(openRequest, resolvedAgentKey)
    : normalizedRestoredEmbedPath || buildAgentWebclientCopilotPath(null, resolvedAgentKey);

  useEffect(() => {
    if (open) {
      setMounted(true);
    }
  }, [open]);

  useEffect(() => {
    if (!open) {
      onRunningRunIdChange(null);
    }
  }, [onRunningRunIdChange, open]);

  function handleCurrentUrlChange(currentUrl: string) {
    const embedPath = normalizeCopilotEmbedPath(currentUrl);
    const selectedAgentKey = readCopilotAgentKeyFromUrl(currentUrl);
    if (!selectedAgentKey || !embedPath) {
      return;
    }
    onSelectedAgentKeyChange?.(selectedAgentKey);
    const chatId = readCopilotChatId(embedPath);
    onCurrentEmbedPathChange?.(embedPath, selectedAgentKey, chatId || undefined);
  }

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
      {mounted ? (
        <Suspense fallback={null}>
          <PluginPage
            key={AGENT_WEBCLIENT_COPILOT_DOCK_SURFACE_ID}
            active={open}
            embedPath={targetEmbedPath}
            hostTheme={hostTheme}
            pluginId="agent-webclient"
            surfaceId={AGENT_WEBCLIENT_COPILOT_DOCK_SURFACE_ID}
            surfaceLabel={t("copilotDock.surfaceLabel")}
            skipContextRegistration
            devToolsTarget="copilot"
            loadInitialEmbeddedUrlDirectly
            suppressInitialLoadingCopy
            onCurrentUrlChange={handleCurrentUrlChange}
          />
        </Suspense>
      ) : null}
    </aside>
  );
}
