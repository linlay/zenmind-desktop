import { useEffect, useState } from "react";
import type { AssistantSettingsPublic } from "../../../shared/contracts";
import { DEFAULT_QUICK_ASSISTANT_AGENT_KEY } from "../../../shared/assistant-settings";
import { PRODUCT_NAME, STORAGE_NAMESPACE } from "../../../shared/brand";
import { useServices } from "../../services/ServicesContext";
import { PluginPage } from "../../pages/plugin/PluginPage";
import { useI18n } from "../../i18n/useI18n";

type ThemeMode = "light" | "dark";

const QUICK_COPILOT_THEME_STORAGE_KEY = `${STORAGE_NAMESPACE}.theme`;
const QUICK_COPILOT_STARTUP_SERVICE_IDS = ["identity-center", "agent-platform", "agent-webclient"] as const;
const AGENT_WEBCLIENT_COPILOT_PATH = "/copilot";
const AGENT_WEBCLIENT_QUICK_COPILOT_SURFACE_ID = "agent-webclient-quick-copilot";

function buildAgentWebclientCopilotPath(agentKey: string) {
  const normalizedAgentKey = agentKey.trim();
  return normalizedAgentKey
    ? `${AGENT_WEBCLIENT_COPILOT_PATH}/${encodeURIComponent(normalizedAgentKey)}`
    : AGENT_WEBCLIENT_COPILOT_PATH;
}

function readStoredThemeMode() {
  if (typeof window === "undefined") {
    return "light";
  }
  try {
    return window.localStorage.getItem(QUICK_COPILOT_THEME_STORAGE_KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

export function QuickCopilotRoute() {
  const { t } = useI18n();
  const { services, loading, error, refresh } = useServices();
  const [hostTheme, setHostTheme] = useState<ThemeMode>(() => readStoredThemeMode());
  const [assistantSettings, setAssistantSettings] = useState<AssistantSettingsPublic | null>(null);
  const startupServices = QUICK_COPILOT_STARTUP_SERVICE_IDS.map((serviceId) =>
    services.find((service) => service.id === serviceId) ?? null
  );
  const allReady = !loading && startupServices.every((service) => service?.status === "running");
  const failedService = startupServices.find((service) => service && service.status !== "running");

  useEffect(() => {
    document.body.classList.add("quick-web-copilot-body");
    return () => {
      document.body.classList.remove("quick-web-copilot-body");
    };
  }, []);

  useEffect(() => {
    const nextTheme = readStoredThemeMode();
    setHostTheme(nextTheme);
    document.documentElement.dataset.theme = nextTheme;
  }, []);

  useEffect(() => {
    let cancelled = false;
    window.electronAPI.assistant.getSettings()
      .then((settings) => {
        if (!cancelled) {
          setAssistantSettings(settings);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setAssistantSettings(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const quickAssistantAgentKey = assistantSettings?.quickAssistantAgentKey || DEFAULT_QUICK_ASSISTANT_AGENT_KEY;
  const quickAssistantEmbedPath = buildAgentWebclientCopilotPath(quickAssistantAgentKey);

  if (!allReady) {
    return (
      <main className="quick-web-copilot-status" aria-live="polite">
        <div className="quick-web-copilot-status-panel">
          <strong>{error || failedService ? t("quickCopilot.notReady") : t("quickCopilot.starting")}</strong>
          <span>
            {error ||
              failedService?.message ||
              t("quickCopilot.restoring", { appName: PRODUCT_NAME })}
          </span>
          <div className="quick-web-copilot-status-actions">
            <button type="button" onClick={() => void refresh()}>
              {t("quickCopilot.recheck")}
            </button>
            <button type="button" onClick={() => void window.electronAPI.quickAssistant.openControlCenter()}>
              {t("nav.controlCenter")}
            </button>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="quick-web-copilot">
      <PluginPage
        active
        embedPath={quickAssistantEmbedPath}
        hostTheme={hostTheme}
        pluginId="agent-webclient"
        surfaceId={AGENT_WEBCLIENT_QUICK_COPILOT_SURFACE_ID}
        surfaceLabel={t("copilotDock.surfaceLabel")}
        devToolsTarget="copilot"
        loadInitialEmbeddedUrlDirectly
      />
      <span className="quick-web-copilot-agent-marker" data-open-agent-key={quickAssistantAgentKey} aria-hidden="true" />
    </main>
  );
}
