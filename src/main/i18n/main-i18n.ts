import type { App } from "electron";
import { createTranslator, DEFAULT_LOCALE, normalizeLocale, type LocaleSettings, type SupportedLocale } from "../../shared/i18n";
import { readDesktopLocaleSettings, saveDesktopLocale } from "./desktop-locale-store";

let currentLocale: SupportedLocale = DEFAULT_LOCALE;
let currentTranslator = createTranslator(currentLocale);

export function initializeMainI18n(app: App): LocaleSettings {
  const settings = readDesktopLocaleSettings(app);
  currentLocale = settings.locale;
  currentTranslator = createTranslator(currentLocale);
  return settings;
}

export function getMainLocale() {
  return currentLocale;
}

export function getMainLocaleSettings(): LocaleSettings {
  return { locale: currentLocale, source: "stored" };
}

export function setMainLocale(app: App, locale: unknown): LocaleSettings {
  const normalized = normalizeLocale(locale) ?? DEFAULT_LOCALE;
  const settings = saveDesktopLocale(app, normalized);
  currentLocale = settings.locale;
  currentTranslator = createTranslator(currentLocale);
  return settings;
}

export function t(...args: Parameters<typeof currentTranslator>) {
  return currentTranslator(...args);
}
