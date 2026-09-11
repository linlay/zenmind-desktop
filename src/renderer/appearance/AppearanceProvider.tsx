import { createContext, useContext, useLayoutEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { createBrowserAppearanceController, skinPackageApiAvailable } from "./browser";
import { ConfigProvider, type ThemeConfig } from "antd";
import { readDocumentAntAppearanceTheme } from "./antdTheme";

const AppearanceContext = createContext<ReturnType<typeof createBrowserAppearanceController> | null>(null);
const subscribeWithoutAppearance = () => () => {};
const readWithoutAppearance = () => null;

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
    skinPackagesAvailable: snapshot.skinSettings.packageApiVersion === 1 && skinPackageApiAvailable() && typeof controller.importSkinPackage === "function",
    importSkinPackage: () => typeof controller.importSkinPackage === "function" ? controller.importSkinPackage() : Promise.reject(new Error("runtimeOutdated")),
    removeSkinPackage: (id: Parameters<typeof controller.removeSkinPackage>[0]) => typeof controller.removeSkinPackage === "function" ? controller.removeSkinPackage(id) : Promise.reject(new Error("runtimeOutdated")),
    importBackground: controller.importBackground,
    resetBackground: controller.resetBackground,
    refreshAppearanceFromCanonical: controller.refreshFromCanonical
  };
}

// Embedded service views also exist in auxiliary windows, which must not start
// the main window's skin controller or call its owner-restricted settings IPC.
export function useAppearanceSnapshot() {
  const controller = useContext(AppearanceContext);
  const read = controller?.getSnapshot ?? readWithoutAppearance;
  return useSyncExternalStore(controller?.subscribe ?? subscribeWithoutAppearance, read, read);
}
