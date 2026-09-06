import fs from "node:fs";
import path from "node:path";
import type { App } from "electron";
import { DEFAULT_LOCALE, normalizeLocale, type LocaleSettings, type SupportedLocale } from "../../../shared/i18n";
import { getDesktopConfigRoot } from "../../infrastructure/filesystem/user-paths";
import {
  DESKTOP_PROFILE_FILE,
  readDesktopProfileFromRoot,
  updateDesktopProfileInRoot
} from "../../infrastructure/filesystem/profile-store";

const PREFERENCES_FILE = DESKTOP_PROFILE_FILE;
const FIRST_INSTALL_DEFAULT_LOCALE: SupportedLocale = "en-US";

export type DesktopPreferences = {
  locale: SupportedLocale;
};

type DesktopLocaleReadOptions = {
  isFirstInstall?: boolean;
};

function getPreferencesPath(app: App) {
  return path.join(getDesktopConfigRoot(app), PREFERENCES_FILE);
}

function hasStoredPreferences(app: App) {
  return fs.existsSync(getPreferencesPath(app));
}

function readStoredPreferences(app: App, options: DesktopLocaleReadOptions = {}): DesktopPreferences {
  return {
    locale: readDesktopProfileFromRoot(getDesktopConfigRoot(app), {
      defaultLocale: options.isFirstInstall ? FIRST_INSTALL_DEFAULT_LOCALE : undefined
    }).appearance.locale
  };
}

function getSystemLocale(app: App) {
  try {
    return normalizeLocale(app.getLocale());
  } catch {
    return null;
  }
}

export function readDesktopLocaleSettings(app: App, options: DesktopLocaleReadOptions = {}): LocaleSettings {
  if (hasStoredPreferences(app)) {
    const storedLocale = normalizeLocale(readStoredPreferences(app, options).locale);
    if (storedLocale) {
      return { locale: storedLocale, source: "stored" };
    }
  }
  if (options.isFirstInstall) {
    return { locale: FIRST_INSTALL_DEFAULT_LOCALE, source: "default" };
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
  const current = readDesktopPreferences(app);
  const next: DesktopPreferences = {
    ...current,
    ...(normalizeLocale(patch.locale) ? { locale: normalizeLocale(patch.locale) as SupportedLocale } : {})
  };
  updateDesktopProfileInRoot(getDesktopConfigRoot(app), {
    appearance: {
      locale: next.locale
    }
  });
  return next;
}

export function saveDesktopLocale(app: App, locale: SupportedLocale): LocaleSettings {
  saveDesktopPreferences(app, { locale });
  return { locale, source: "stored" };
}

export const __testInternals = {
  FIRST_INSTALL_DEFAULT_LOCALE,
  PREFERENCES_FILE,
  getPreferencesPath
};
