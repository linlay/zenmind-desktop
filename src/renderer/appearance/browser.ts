import { STORAGE_NAMESPACE } from "../../shared/brand";
import { isDesktopSkinId, type DesktopSkinId } from "../../shared/desktop-appearance";
import { createAppearanceController } from "./controller";
import {
  createAppearanceSnapshot,
  isThemePreference,
  type DesktopAppearanceSnapshot,
  type ThemePreference
} from "./model";

const THEME_STORAGE_KEY = `${STORAGE_NAMESPACE}.theme`;
const SKIN_STORAGE_KEY = `${STORAGE_NAMESPACE}.desktop-skin`;
const SYSTEM_THEME_QUERY = "(prefers-color-scheme: dark)";

export function readCachedThemePreference(): ThemePreference {
  try {
    const saved = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemePreference(saved) ? saved : "light";
  } catch {
    return "light";
  }
}

function cacheThemePreference(theme: ThemePreference) {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // The Main profile remains authoritative when browser storage is blocked.
  }
}

export function bootstrapAppearance() {
  const snapshot = createAppearanceSnapshot(
    readCachedThemePreference(), window.matchMedia(SYSTEM_THEME_QUERY).matches
  );
  // Auxiliary windows retain their existing theme bootstrap; shell skins are
  // attached separately, only for the main AppShell's lifetime.
  document.documentElement.dataset.theme = snapshot.resolvedTheme;
}

export function createDocumentAppearanceTarget(root: HTMLElement) {
  let attached = false;
  let previousSkin: string | undefined;
  let previousBackground: string | undefined;
  let previousBackgroundSource: string | undefined;
  const previousTokens = new Map<string, { value: string; priority: string }>();

  function restoreTokens() {
    previousTokens.forEach(({ value, priority }, token) => {
      if (value) root.style.setProperty(token, value, priority);
      else root.style.removeProperty(token);
    });
    previousTokens.clear();
  }

  return {
    apply(snapshot: DesktopAppearanceSnapshot) {
      if (!attached) {
        previousSkin = root.dataset.desktopSkin;
        previousBackground = root.dataset.desktopBackground;
        previousBackgroundSource = root.dataset.desktopBackgroundSource;
        attached = true;
      }
      restoreTokens();
      root.dataset.theme = snapshot.resolvedTheme;
      root.dataset.desktopSkin = snapshot.skin.id;
      root.dataset.desktopBackground = snapshot.background ? "image" : "none";
      root.dataset.desktopBackgroundSource = snapshot.skinSettings.backgroundDataUrl
        ? "custom" : snapshot.background ? "skin" : "none";
      Object.entries(snapshot.skin.tokens[snapshot.resolvedTheme]).forEach(([token, value]) => {
        previousTokens.set(token, {
          value: root.style.getPropertyValue(token),
          priority: root.style.getPropertyPriority(token)
        });
        root.style.setProperty(token, value);
      });
    },
    release() {
      if (!attached) return;
      restoreTokens();
      if (previousSkin === undefined) delete root.dataset.desktopSkin;
      else root.dataset.desktopSkin = previousSkin;
      if (previousBackground === undefined) delete root.dataset.desktopBackground;
      else root.dataset.desktopBackground = previousBackground;
      if (previousBackgroundSource === undefined) delete root.dataset.desktopBackgroundSource;
      else root.dataset.desktopBackgroundSource = previousBackgroundSource;
      attached = false;
    }
  };
}

export function createBrowserAppearanceController() {
  const media = window.matchMedia(SYSTEM_THEME_QUERY);
  const target = createDocumentAppearanceTarget(document.documentElement);
  return createAppearanceController({
    readCachedTheme: readCachedThemePreference,
    cacheTheme: cacheThemePreference,
    readCachedSkin() {
      try {
        const id = window.localStorage.getItem(SKIN_STORAGE_KEY);
        return isDesktopSkinId(id) ? id : "default";
      } catch { return "default"; }
    },
    cacheSkin(id: DesktopSkinId) {
      try { window.localStorage.setItem(SKIN_STORAGE_KEY, id); } catch { /* Profile remains authoritative. */ }
    },
    getDesktopSkin: () => window.electronAPI.settings.getDesktopSkin(),
    setDesktopSkin: (id, options) => window.electronAPI.settings.setDesktopSkin(id, options),
    importDesktopSkinPackage: () => callSkinPackageApi("importDesktopSkinPackage"),
    removeDesktopSkinPackage: (id) => callSkinPackageApi("removeDesktopSkinPackage", id),
    importDesktopBackground: () => window.electronAPI.settings.importDesktopBackground(),
    resetDesktopBackground: () => window.electronAPI.settings.resetDesktopBackground(),
    systemUsesDarkColors: () => media.matches,
    subscribeSystemTheme(listener) {
      media.addEventListener("change", listener);
      return () => media.removeEventListener("change", listener);
    },
    getThemePreference: () => window.electronAPI.settings.getThemePreference(),
    setNativeThemeSource: (themeMode) => window.electronAPI.settings.setNativeThemeSource(themeMode),
    ...target
  });
}

export function skinPackageApiAvailable() {
  return typeof window.electronAPI.settings.importDesktopSkinPackage === "function" &&
    typeof window.electronAPI.settings.removeDesktopSkinPackage === "function";
}

// Renderer hot updates cannot install new preload methods or Main handlers in
// an already-running Electron process. Report that boundary explicitly.
async function callSkinPackageApi(method: "importDesktopSkinPackage" | "removeDesktopSkinPackage", id?: DesktopSkinId) {
  if (!skinPackageApiAvailable()) throw new Error("runtimeOutdated");
  try {
    return method === "importDesktopSkinPackage" ? await window.electronAPI.settings.importDesktopSkinPackage()
      : await window.electronAPI.settings.removeDesktopSkinPackage(id!);
  } catch (error) {
    if (error instanceof Error && /No handler registered/.test(error.message)) throw new Error("runtimeOutdated");
    throw error;
  }
}
