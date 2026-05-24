import fs from "node:fs";
import path from "node:path";
import type { App } from "electron";
import { DEFAULT_LOCALE, normalizeLocale, type LocaleSettings, type SupportedLocale } from "../../shared/i18n";
import { getDesktopConfigRoot } from "../user-paths";

const PREFERENCES_FILE = "preferences.json";

export type DesktopPreferences = {
  locale: SupportedLocale;
};

function getPreferencesPath(app: App) {
  return path.join(getDesktopConfigRoot(app), PREFERENCES_FILE);
}

function ensurePreferencesRoot(app: App) {
  fs.mkdirSync(getDesktopConfigRoot(app), { recursive: true });
}

function readStoredPreferences(app: App): Partial<DesktopPreferences> {
  try {
    const raw = fs.readFileSync(getPreferencesPath(app), "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Partial<DesktopPreferences>
      : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

function getSystemLocale(app: App) {
  try {
    return normalizeLocale(app.getLocale());
  } catch {
    return null;
  }
}

export function readDesktopLocaleSettings(app: App): LocaleSettings {
  const storedLocale = normalizeLocale(readStoredPreferences(app).locale);
  if (storedLocale) {
    return { locale: storedLocale, source: "stored" };
  }
  const systemLocale = getSystemLocale(app);
  if (systemLocale) {
    return { locale: systemLocale, source: "system" };
  }
  return { locale: DEFAULT_LOCALE, source: "default" };
}

export function readDesktopPreferences(app: App): DesktopPreferences {
  return { locale: readDesktopLocaleSettings(app).locale };
}

export function saveDesktopPreferences(app: App, patch: Partial<DesktopPreferences>): DesktopPreferences {
  ensurePreferencesRoot(app);
  const current = readDesktopPreferences(app);
  const next: DesktopPreferences = {
    ...current,
    ...(normalizeLocale(patch.locale) ? { locale: normalizeLocale(patch.locale) as SupportedLocale } : {})
  };
  fs.writeFileSync(getPreferencesPath(app), `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

export function saveDesktopLocale(app: App, locale: SupportedLocale): LocaleSettings {
  saveDesktopPreferences(app, { locale });
  return { locale, source: "stored" };
}

export const __testInternals = {
  PREFERENCES_FILE,
  getPreferencesPath
};
