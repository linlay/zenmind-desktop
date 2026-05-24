import { useLocation } from "react-router-dom";
import { AppShell } from "./app-shell/AppShell";
import { DesktopPet } from "./copilot/pet-copilot/DesktopPet";
import { QuickCopilotRoute } from "./copilot/quick-copilot/QuickCopilotRoute";
import { LogViewerPage } from "./pages/LogViewerPage";
import { ServicesProvider } from "./services/ServicesContext";
import { DESKTOP_PET_ROUTE } from "../shared/desktop-pet";
import { I18nProvider } from "./i18n/I18nProvider";

export { EXTERNAL_EXPERIMENTAL_ITEMS } from "./app-shell/AppShell";

export function App() {
  const location = useLocation();
  if (location.pathname === "/quick-assistant") {
    return (
      <ServicesProvider>
        <QuickCopilotRoute />
      </ServicesProvider>
    );
  }
  if (location.pathname === DESKTOP_PET_ROUTE) {
    return <DesktopPet />;
  }
  if (location.pathname === "/log-viewer") {
    return (
      <ServicesProvider>
        <LogViewerPage />
      </ServicesProvider>
    );
  }

  return (
    <I18nProvider>
      <ServicesProvider>
        <AppShell />
      </ServicesProvider>
    </I18nProvider>
  );
}
