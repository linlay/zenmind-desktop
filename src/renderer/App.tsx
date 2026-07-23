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
const LogViewerPage = lazy(() =>
  import("./pages/LogViewerPage").then((module) => ({ default: module.LogViewerPage }))
);

export function App() {
  const location = useLocation();
  const resetKey = `${location.pathname}${location.search}${location.hash}`;
  let content;
  if (location.pathname === DESKTOP_PET_ROUTE) {
    content = (
      <AppErrorBoundary resetKey={resetKey}>
        <Suspense fallback={null}>
          <DesktopPet />
        </Suspense>
      </AppErrorBoundary>
    );
  } else if (location.pathname === "/log-viewer") {
    content = (
      <AppErrorBoundary resetKey={resetKey}>
        <ServicesProvider>
          <Suspense fallback={null}>
            <LogViewerPage />
          </Suspense>
        </ServicesProvider>
      </AppErrorBoundary>
    );
  } else {
    content = (
      <AppErrorBoundary resetKey={resetKey}>
        <ServicesProvider>
          <AppShell />
        </ServicesProvider>
      </AppErrorBoundary>
    );
  }

  return (
    <I18nProvider>
      {content}
    </I18nProvider>
  );
}
