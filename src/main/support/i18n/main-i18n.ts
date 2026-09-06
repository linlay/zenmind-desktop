import type { App } from "electron";
import { createTranslator, DEFAULT_LOCALE, normalizeLocale, type LocaleSettings, type SupportedLocale } from "../../../shared/i18n";
import { readDesktopLocaleSettings, saveDesktopLocale } from "./desktop-locale-store";

let currentLocale: SupportedLocale = DEFAULT_LOCALE;
let currentSettings: LocaleSettings = { locale: DEFAULT_LOCALE, source: "default" };
let currentTranslator = createTranslator(currentLocale);

export function initializeMainI18n(app: App, options: { isFirstInstall?: boolean } = {}): LocaleSettings {
  const settings = readDesktopLocaleSettings(app, options);
  currentLocale = settings.locale;
  currentSettings = settings;
  currentTranslator = createTranslator(currentLocale);
  return settings;
}

export function getMainLocale() {
  return currentLocale;
}

export function getMainLocaleSettings(): LocaleSettings {
  return currentSettings;
}

export function setMainLocale(app: App, locale: unknown): LocaleSettings {
  const normalized = normalizeLocale(locale) ?? DEFAULT_LOCALE;
  const settings = saveDesktopLocale(app, normalized);
  currentLocale = settings.locale;
  currentSettings = settings;
  currentTranslator = createTranslator(currentLocale);
  return settings;
}

export function setMainLocaleForCurrentProcess(locale: unknown): LocaleSettings {
  const normalized = normalizeLocale(locale) ?? DEFAULT_LOCALE;
  currentLocale = normalized;
  currentSettings = { locale: normalized, source: "default" };
  currentTranslator = createTranslator(currentLocale);
  return currentSettings;
}

export function t(...args: Parameters<typeof currentTranslator>) {
  return currentTranslator(...args);
}
