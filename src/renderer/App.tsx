import { useLocation } from "react-router-dom";
import { AppErrorBoundary } from "./AppErrorBoundary";
import { AppShell } from "./app-shell/AppShell";
import { DesktopPet } from "./copilot/pet-copilot/DesktopPet";
import { QuickCopilotRoute } from "./copilot/quick-copilot/QuickCopilotRoute";
import { DebugViewerPage } from "./pages/DebugViewerPage";
import { AgentPlatformMonitorPage } from "./pages/AgentPlatformMonitorPage";
import { LogViewerPage } from "./pages/LogViewerPage";
import { ServicesProvider } from "./services/ServicesContext";
import { DESKTOP_PET_ROUTE } from "../shared/desktop-pet";
import { I18nProvider } from "./i18n/I18nProvider";

export { EXTERNAL_EXPERIMENTAL_ITEMS } from "./app-shell/AppShell";

export function App() {
  const location = useLocation();
  const resetKey = `${location.pathname}${location.search}${location.hash}`;
  if (location.pathname === "/quick-assistant") {
    return (
      <AppErrorBoundary resetKey={resetKey}>
        <ServicesProvider>
          <QuickCopilotRoute />
        </ServicesProvider>
      </AppErrorBoundary>
    );
  }
  if (location.pathname === DESKTOP_PET_ROUTE) {
    return (
      <AppErrorBoundary resetKey={resetKey}>
        <DesktopPet />
      </AppErrorBoundary>
    );
  }
  if (location.pathname === "/log-viewer") {
    return (
      <AppErrorBoundary resetKey={resetKey}>
        <ServicesProvider>
          <LogViewerPage />
        </ServicesProvider>
      </AppErrorBoundary>
    );
  }
  if (location.pathname === "/agent-platform-monitor") {
    return (
      <AppErrorBoundary resetKey={resetKey}>
        <I18nProvider>
          <AgentPlatformMonitorPage />
        </I18nProvider>
      </AppErrorBoundary>
    );
  }
  if (location.pathname === "/debug-viewer") {
    return (
      <AppErrorBoundary resetKey={resetKey}>
        <I18nProvider>
          <DebugViewerPage />
        </I18nProvider>
      </AppErrorBoundary>
    );
  }

  return (
    <AppErrorBoundary resetKey={resetKey}>
      <I18nProvider>
        <ServicesProvider>
          <AppShell />
        </ServicesProvider>
      </I18nProvider>
    </AppErrorBoundary>
  );
}
