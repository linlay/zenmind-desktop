import { createContext, useContext, useLayoutEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { createBrowserAppearanceController } from "./browser";
import { ConfigProvider, type ThemeConfig } from "antd";
import { readDocumentAntAppearanceTheme } from "./antdTheme";

const AppearanceContext = createContext<ReturnType<typeof createBrowserAppearanceController> | null>(null);

export function AppearanceProvider({ children }: { children: ReactNode }) {
  const [controller] = useState(createBrowserAppearanceController);
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  // Keep a provider present from the first render; theme changes must not
  // replace Ant's context tree and remount the mounted shell or its guests.
  const [componentTheme, setComponentTheme] = useState<ThemeConfig>({});
  useLayoutEffect(() => controller.start(), [controller]);
  useLayoutEffect(() => {
    setComponentTheme(readDocumentAntAppearanceTheme(snapshot.resolvedTheme));
  }, [snapshot.resolvedTheme, snapshot.skin]);
  return (
    <AppearanceContext.Provider value={controller}>
      <ConfigProvider theme={componentTheme}>{children}</ConfigProvider>
    </AppearanceContext.Provider>
  );
}

export function useAppearance() {
  const controller = useContext(AppearanceContext);
  if (!controller) throw new Error("Main-window appearance requires AppearanceProvider.");
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  return {
    ...snapshot,
    getAppearanceSnapshot: controller.getSnapshot,
    setThemeMode: controller.setThemeMode,
    setSkinId: controller.setSkinId,
    importBackground: controller.importBackground,
    resetBackground: controller.resetBackground,
    refreshAppearanceFromCanonical: controller.refreshFromCanonical
  };
}
