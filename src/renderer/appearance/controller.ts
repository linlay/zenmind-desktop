import {
  createAppearanceSnapshot,
  isThemePreference,
  type DesktopAppearanceSnapshot,
  type ThemePreference
} from "./model";
import { findDesktopSkin } from "./skins";
import { isDesktopSkinId, type DesktopSkinId, type DesktopSkinResult, type DesktopSkinView, type DesktopSkinSelectionOptions, type InstalledDesktopSkinId } from "../../shared/desktop-appearance";

export type AppearanceEnvironment = {
  readCachedTheme: () => ThemePreference;
  cacheTheme: (theme: ThemePreference) => void;
  readCachedSkin: () => DesktopSkinId;
  cacheSkin: (id: DesktopSkinId) => void;
  getDesktopSkin: () => Promise<DesktopSkinResult>;
  setDesktopSkin: (id: DesktopSkinId, options?: DesktopSkinSelectionOptions) => Promise<DesktopSkinResult>;
  importDesktopSkinPackage: () => Promise<DesktopSkinResult>;
  removeDesktopSkinPackage: (id: DesktopSkinId) => Promise<DesktopSkinResult>;
  importDesktopBackground: () => Promise<DesktopSkinResult>;
  resetDesktopBackground: () => Promise<DesktopSkinResult>;
  systemUsesDarkColors: () => boolean;
  subscribeSystemTheme: (listener: () => void) => () => void;
  getThemePreference: () => Promise<unknown>;
  setNativeThemeSource: (theme: ThemePreference) => Promise<{
    ok: boolean;
    themeSource: ThemePreference;
  }>;
  apply: (snapshot: DesktopAppearanceSnapshot) => void;
  release: () => void;
};

export function createAppearanceController(environment: AppearanceEnvironment) {
  let skinSettings: DesktopSkinView = { skinId: environment.readCachedSkin(), background: null, backgroundDataUrl: null };
  function resolveSkin() {
    return findDesktopSkin(skinSettings.skinId) ??
      (skinSettings.installedSkin?.id === skinSettings.skinId ? skinSettings.installedSkin : undefined);
  }
  let confirmedSkin = skinSettings;
  let skinLoadState: DesktopAppearanceSnapshot["skinLoadState"] = "loading";
  let skinSaving = false;
  let skinReadRevision = 0, skinWriteRevision = 0;
  let skinWrites: Promise<void> = Promise.resolve();
  let snapshot = createAppearanceSnapshot(
    environment.readCachedTheme(), environment.systemUsesDarkColors(), resolveSkin(),
    skinSettings, skinLoadState, skinSaving
  );
  let confirmedTheme = snapshot.themeMode;
  let active = false;
  let generation = 0;
  let readRevision = 0;
  let writeRevision = 0;
  let writes: Promise<void> = Promise.resolve();
  const listeners = new Set<() => void>();

  function publish(theme: ThemePreference = snapshot.themeMode) {
    const next = createAppearanceSnapshot(theme, environment.systemUsesDarkColors(), resolveSkin(), skinSettings, skinLoadState, skinSaving);
    if (next.themeMode === snapshot.themeMode && next.resolvedTheme === snapshot.resolvedTheme &&
      next.skinSettings === snapshot.skinSettings && next.skinLoadState === snapshot.skinLoadState && next.skinSaving === snapshot.skinSaving) {
      return;
    }
    snapshot = next;
    // Body portals and React consumers observe the same committed appearance.
    environment.apply(snapshot);
    listeners.forEach((listener) => listener());
  }

  function enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
    const result = writes.then(operation);
    writes = result.then(() => undefined, () => undefined);
    return result;
  }

  async function persistTheme(theme: ThemePreference) {
    const result = await environment.setNativeThemeSource(theme);
    if (!result.ok || result.themeSource !== theme) {
      throw new Error("Desktop theme preference could not be saved.");
    }
  }

  async function refreshThemeFromCanonical() {
    const currentGeneration = generation;
    const currentRead = ++readRevision;
    const currentWrite = writeRevision;
    const isCurrent = () => active && currentGeneration === generation &&
      currentRead === readRevision && currentWrite === writeRevision;

    try {
      // A config refresh must not read the profile halfway through a UI save.
      await writes;
      if (!isCurrent()) return;
      const theme = await environment.getThemePreference();
      if (!isCurrent() || !isThemePreference(theme)) return;
      confirmedTheme = theme;
      environment.cacheTheme(theme);
      publish(theme);

      // The existing IPC also applies nativeTheme and refreshes window chrome.
      // Only a successful canonical read can take this path; never write a
      // startup cache back after a failed read.
      await enqueueWrite(async () => {
        if (isCurrent()) await persistTheme(theme);
      });
    } catch {
      // Retain the last usable appearance while the settings bridge recovers.
    }
  }

  async function setThemeMode(theme: ThemePreference) {
    if (!active) throw new Error("Desktop appearance is not active.");
    const currentGeneration = generation;
    const currentWrite = ++writeRevision;
    ++readRevision;
    const isCurrent = () => active && currentGeneration === generation &&
      currentWrite === writeRevision;
    publish(theme);

    try {
      await enqueueWrite(async () => {
        await persistTheme(theme);
        confirmedTheme = theme;
      });
      if (isCurrent()) {
        environment.cacheTheme(theme);
        publish(theme);
      }
      return createAppearanceSnapshot(theme, environment.systemUsesDarkColors(), snapshot.skin, skinSettings, skinLoadState, skinSaving);
    } catch (error) {
      if (isCurrent()) {
        environment.cacheTheme(confirmedTheme);
        publish(confirmedTheme);
      }
      throw error;
    }
  }

  function unwrapSkin(result: DesktopSkinResult) {
    if (!result.ok) throw new Error(result.error);
    if (!isDesktopSkinId(result.settings.skinId)) throw new Error("unavailable");
    return result.settings;
  }

  async function refreshSkinFromCanonical() {
    const currentGeneration = generation, currentRead = ++skinReadRevision, currentWrite = skinWriteRevision;
    const isCurrent = () => active && currentGeneration === generation && currentRead === skinReadRevision && currentWrite === skinWriteRevision;
    try {
      await skinWrites;
      if (!isCurrent()) return;
      const settings = unwrapSkin(await environment.getDesktopSkin());
      if (!isCurrent()) return;
      skinSettings = confirmedSkin = settings;
      skinLoadState = "ready";
      skinSaving = false;
      environment.cacheSkin(settings.skinId);
      publish();
    } catch {
      if (isCurrent()) { skinLoadState = "error"; skinSaving = false; publish(); }
    }
  }

  async function saveSkin(operation: () => Promise<DesktopSkinResult>, optimisticSkin?: DesktopSkinId) {
    if (!active) throw new Error("Desktop appearance is not active.");
    const currentGeneration = generation, currentWrite = ++skinWriteRevision;
    ++skinReadRevision;
    const isCurrent = () => active && currentGeneration === generation && currentWrite === skinWriteRevision;
    if (optimisticSkin) skinSettings = { ...skinSettings, skinId: optimisticSkin };
    skinSaving = true;
    publish();
    const result = skinWrites.then(async () => {
      const saved = await operation();
      const settings = unwrapSkin(saved);
      confirmedSkin = settings;
      return { settings, cancelled: saved.ok && Boolean(saved.cancelled) };
    });
    skinWrites = result.then(() => undefined, () => undefined);
    try {
      const saved = await result;
      if (isCurrent()) {
        skinSettings = saved.settings;
        skinLoadState = "ready";
        environment.cacheSkin(skinSettings.skinId);
      }
      return saved.cancelled;
    } catch (error) {
      if (isCurrent()) {
        skinSettings = confirmedSkin;
        environment.cacheSkin(skinSettings.skinId);
      }
      throw error;
    } finally {
      if (isCurrent()) { skinSaving = false; publish(); }
    }
  }

  function setSkinId(id: string, options?: DesktopSkinSelectionOptions) {
    if (!isDesktopSkinId(id) || (!findDesktopSkin(id) && !skinSettings.installedSkins?.some((skin) => skin.id === id))) throw new Error("Unknown desktop skin.");
    // Installed definitions arrive only after Main confirms the selection.
    return saveSkin(() => environment.setDesktopSkin(id, options), findDesktopSkin(id) ? id : undefined);
  }

  async function importSkinPackage() {
    let importedSkinId: InstalledDesktopSkinId | undefined;
    await saveSkin(async () => {
      const result = await environment.importDesktopSkinPackage();
      if (result.ok) importedSkinId = result.importedSkinId;
      return result;
    });
    return importedSkinId;
  }

  async function refreshFromCanonical() {
    await Promise.all([refreshThemeFromCanonical(), refreshSkinFromCanonical()]);
  }

  function start() {
    active = true;
    const currentGeneration = ++generation;
    publish(snapshot.themeMode);
    environment.apply(snapshot);
    const unsubscribe = environment.subscribeSystemTheme(() => {
      if (active && currentGeneration === generation) publish(snapshot.themeMode);
    });
    void refreshFromCanonical();
    return () => {
      unsubscribe();
      if (currentGeneration !== generation) return;
      active = false;
      ++generation;
      ++readRevision;
      ++skinReadRevision;
      environment.release();
    };
  }

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    start,
    setThemeMode,
    setSkinId,
    importSkinPackage,
    removeSkinPackage: (id: DesktopSkinId) => saveSkin(() => environment.removeDesktopSkinPackage(id)),
    importBackground: () => saveSkin(environment.importDesktopBackground),
    resetBackground: () => saveSkin(environment.resetDesktopBackground),
    refreshFromCanonical
  };
}
