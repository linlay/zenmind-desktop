import { useEffect, useState } from "react";
import type { AssistantSettingsPublic } from "../../../shared/contracts";
import { DEFAULT_QUICK_ASSISTANT_AGENT_KEY } from "../../../shared/assistant-settings";
import { useServices } from "../../services/ServicesContext";
import { PluginPage } from "../../pages/plugin/PluginPage";

type ThemeMode = "light" | "dark";

const QUICK_COPILOT_THEME_STORAGE_KEY = "zenmind-desktop.theme";
const QUICK_COPILOT_STARTUP_SERVICE_IDS = ["zenmind-app-server", "agent-platform", "agent-webclient"] as const;
const AGENT_WEBCLIENT_COPILOT_PATH = "/copilot";

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

  if (!allReady) {
    return (
      <main className="quick-web-copilot-status" aria-live="polite">
        <div className="quick-web-copilot-status-panel">
          <strong>{error || failedService ? "智能助理暂未就绪" : "正在启动智能助理"}</strong>
          <span>
            {error ||
              failedService?.message ||
              "ZenMind 正在恢复认证、智能体平台和 Web Copilot 服务。"}
          </span>
          <div className="quick-web-copilot-status-actions">
            <button type="button" onClick={() => void refresh()}>
              重新检查
            </button>
            <button type="button" onClick={() => void window.electronAPI.quickAssistant.openControlCenter()}>
              控制中心
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
        embedPath={AGENT_WEBCLIENT_COPILOT_PATH}
        hostTheme={hostTheme}
        pluginId="agent-webclient"
        surfaceLabel="助手"
      />
      <span className="quick-web-copilot-agent-marker" data-open-agent-key={quickAssistantAgentKey} aria-hidden="true" />
    </main>
  );
}
