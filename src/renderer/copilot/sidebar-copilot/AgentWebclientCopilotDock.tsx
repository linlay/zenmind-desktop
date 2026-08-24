import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent
} from "react";
import type { AssistantWorkerOpenRequest } from "../../../shared/contracts";
import { PRODUCT_NAME } from "../../../shared/brand";
import { createAgentWebclientCopilotPath } from "../../../shared/agent-webclient-routes";
import { decodeRoutePathSegment } from "../../../shared/route-path";
import {
  COPILOT_DOCK_SURFACE_ID,
  createSurfaceIdentity
} from "../../../shared/surface-identity";
import { useI18n } from "../../i18n/useI18n";
import { SidebarActionIcon } from "../../components/BrandMark";
import {
  normalizeCopilotEmbedPath,
  readCopilotChatId
} from "./copilotDockSession";

const ServiceWebviewSurface = lazy(() =>
  import("../../service-webview/ServiceWebviewSurface").then((module) => ({ default: module.ServiceWebviewSurface }))
);

const AGENT_WEBCLIENT_COPILOT_PATH = "/copilot";
const AGENT_WEBCLIENT_COPILOT_DOCK_SURFACE_ID = COPILOT_DOCK_SURFACE_ID;
type CopilotUrlChangeSource = "host" | "guest";

function normalizeAgentKey(value = "") {
  const trimmed = value.trim();
  return trimmed.startsWith("agent:") ? trimmed.slice("agent:".length).trim() : trimmed;
}

function resolveTargetAgentKey(openRequest: AssistantWorkerOpenRequest | null, fallbackAgentKey = "") {
  return normalizeAgentKey(openRequest?.agentKey ?? openRequest?.workerKey ?? fallbackAgentKey);
}

function appendMustUseSkills(params: URLSearchParams, mustUseSkills: readonly string[]) {
  for (const skillKey of mustUseSkills) {
    params.append("mustUseSkill", skillKey);
  }
}

function buildAgentWebclientCopilotPath(
  openRequest: AssistantWorkerOpenRequest | null,
  fallbackAgentKey = "",
  mustUseSkills: readonly string[] = []
) {
  const agentKey = resolveTargetAgentKey(openRequest, fallbackAgentKey);
  const chatId = openRequest?.chatId?.trim() ?? "";
  if (!agentKey) {
    if (!chatId) {
      return AGENT_WEBCLIENT_COPILOT_PATH;
    }
    const params = new URLSearchParams();
    params.set("chatId", chatId);
    appendMustUseSkills(params, mustUseSkills);
    return `${AGENT_WEBCLIENT_COPILOT_PATH}?${params.toString()}`;
  }

  const params = new URLSearchParams();
  if (chatId) {
    params.set("chatId", chatId);
  }
  appendMustUseSkills(params, mustUseSkills);
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
  parentSurfaceId,
  resolvedAgentKey,
  mustUseSkills = [],
  resize,
  onClose,
  onRunningRunIdChange,
  onSelectedAgentKeyChange,
  onCurrentEmbedPathChange
}: {
  open: boolean;
  hostTheme: "light" | "dark";
  nativeDialogVisible: boolean;
  openRequest: AssistantWorkerOpenRequest | null;
  restoredEmbedPath?: string;
  parentSurfaceId?: string;
  resolvedAgentKey: string;
  mustUseSkills?: readonly string[];
  resize?: {
    active: boolean;
    minWidth: number;
    maxWidth: number;
    width: number;
    onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
    onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  };
  onClose: () => void;
  onRunningRunIdChange: (runId: string | null) => void;
  onSelectedAgentKeyChange?: (agentKey: string) => void;
  onCurrentEmbedPathChange?: (embedPath: string, agentKey: string, chatId?: string) => void;
}) {
  const { t } = useI18n();
  const [mounted, setMounted] = useState(open);
  const liveSurfaceActive = open && !nativeDialogVisible;
  const normalizedRestoredEmbedPath = normalizeCopilotEmbedPath(restoredEmbedPath ?? "");
  const targetEmbedPath = openRequest
    ? buildAgentWebclientCopilotPath(openRequest, resolvedAgentKey, mustUseSkills)
    : normalizedRestoredEmbedPath || buildAgentWebclientCopilotPath(null, resolvedAgentKey, mustUseSkills);
  const targetAgentKey = readCopilotAgentKeyFromUrl(targetEmbedPath) ||
    resolveTargetAgentKey(openRequest, resolvedAgentKey);
  const lastHostTargetEmbedPathRef = useRef("");
  const pendingHostTargetEmbedPathRef = useRef("");
  const lastObservedAgentKeyRef = useRef("");
  if (lastHostTargetEmbedPathRef.current !== targetEmbedPath) {
    lastHostTargetEmbedPathRef.current = targetEmbedPath;
    pendingHostTargetEmbedPathRef.current = targetEmbedPath;
    lastObservedAgentKeyRef.current = targetAgentKey;
  }

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

  function handleCurrentUrlChange(currentUrl: string, source: CopilotUrlChangeSource) {
    const embedPath = normalizeCopilotEmbedPath(currentUrl);
    const selectedAgentKey = readCopilotAgentKeyFromUrl(currentUrl);
    if (!selectedAgentKey || !embedPath) {
      return;
    }
    if (source === "host") {
      return;
    }
    if (pendingHostTargetEmbedPathRef.current) {
      if (pendingHostTargetEmbedPathRef.current !== embedPath) {
        return;
      }
      pendingHostTargetEmbedPathRef.current = "";
      lastObservedAgentKeyRef.current = selectedAgentKey;
      const chatId = readCopilotChatId(embedPath);
      onCurrentEmbedPathChange?.(embedPath, selectedAgentKey, chatId || undefined);
      return;
    }
    const previousAgentKey = lastObservedAgentKeyRef.current;
    lastObservedAgentKeyRef.current = selectedAgentKey;
    if (previousAgentKey && previousAgentKey !== selectedAgentKey) {
      onSelectedAgentKeyChange?.(selectedAgentKey);
    }
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
      {resize ? (
        <div
          className={`copilot-dock-resizer${resize.active ? " is-active" : ""}`}
          role="separator"
          aria-label={t("copilotDock.resize")}
          aria-orientation="vertical"
          aria-valuemin={resize.minWidth}
          aria-valuemax={resize.maxWidth}
          aria-valuenow={resize.width}
          tabIndex={0}
          onKeyDown={resize.onKeyDown}
          onPointerDown={resize.onPointerDown}
        >
          <span className="copilot-dock-resizer-line" aria-hidden="true" />
        </div>
      ) : null}
      {open ? (
        <button
          type="button"
          className="copilot-dock-close-button"
          aria-label={t("sidebar.copilot.close", { appName: PRODUCT_NAME })}
          title={t("sidebar.copilot.close", { appName: PRODUCT_NAME })}
          onClick={onClose}
        >
          <SidebarActionIcon kind="close" className="copilot-dock-close-button-icon" />
        </button>
      ) : null}
      {mounted ? (
        <Suspense fallback={null}>
          <ServiceWebviewSurface
            key={AGENT_WEBCLIENT_COPILOT_DOCK_SURFACE_ID}
            active={liveSurfaceActive}
            embedPath={targetEmbedPath}
            hostTheme={hostTheme}
            serviceId="agent-webclient"
            surfaceIdentity={createSurfaceIdentity("copilot-dock", "", { parentSurfaceId })}
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
