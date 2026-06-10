import { lazy, Suspense } from "react";
import { useLocation } from "react-router-dom";
import { AppErrorBoundary } from "./AppErrorBoundary";
import { AppShell } from "./app-shell/AppShell";
import { ServicesProvider } from "./services/ServicesContext";
import { DESKTOP_PET_ROUTE } from "../shared/desktop-pet";
import { I18nProvider } from "./i18n/I18nProvider";

export { EXTERNAL_EXPERIMENTAL_ITEMS } from "./app-shell/AppShell";

const DesktopPet = lazy(() =>
  import("./copilot/pet-copilot/DesktopPet").then((module) => ({ default: module.DesktopPet }))
);
const QuickCopilotRoute = lazy(() =>
  import("./copilot/quick-copilot/QuickCopilotRoute").then((module) => ({ default: module.QuickCopilotRoute }))
);
const LogViewerPage = lazy(() =>
  import("./pages/LogViewerPage").then((module) => ({ default: module.LogViewerPage }))
);

export function App() {
  const location = useLocation();
  const resetKey = `${location.pathname}${location.search}${location.hash}`;
  if (location.pathname === "/quick-assistant") {
    return (
      <AppErrorBoundary resetKey={resetKey}>
        <ServicesProvider>
          <Suspense fallback={null}>
            <QuickCopilotRoute />
          </Suspense>
        </ServicesProvider>
      </AppErrorBoundary>
    );
  }
  if (location.pathname === DESKTOP_PET_ROUTE) {
    return (
      <AppErrorBoundary resetKey={resetKey}>
        <Suspense fallback={null}>
          <DesktopPet />
        </Suspense>
      </AppErrorBoundary>
    );
  }
  if (location.pathname === "/log-viewer") {
    return (
      <AppErrorBoundary resetKey={resetKey}>
        <ServicesProvider>
          <Suspense fallback={null}>
            <LogViewerPage />
          </Suspense>
        </ServicesProvider>
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
