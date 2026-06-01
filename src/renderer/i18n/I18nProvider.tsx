import { useEffect, useMemo, useState, type ReactNode } from "react";
import { createTranslator, DEFAULT_LOCALE, type LocaleSettings, type SupportedLocale } from "../../shared/i18n";
import { RendererI18nContext } from "./i18n-context";

type I18nProviderProps = {
  children: ReactNode;
};

const fallbackSettings: LocaleSettings = {
  locale: DEFAULT_LOCALE,
  source: "default"
};

function applyDocumentLocale(locale: SupportedLocale) {
  document.documentElement.lang = locale;
}

function readInitialLocaleSettings() {
  try {
    return window.electronAPI.settings.getInitialLocale();
  } catch {
    return fallbackSettings;
  }
}

export function I18nProvider({ children }: I18nProviderProps) {
  const [settings, setSettings] = useState<LocaleSettings>(() => {
    const initialSettings = readInitialLocaleSettings();
    applyDocumentLocale(initialSettings.locale);
    return initialSettings;
  });

  useEffect(() => {
    let cancelled = false;
    window.electronAPI.settings.getLocale()
      .then((nextSettings) => {
        if (!cancelled) {
          setSettings(nextSettings);
        }
      })
      .catch(() => undefined);

    const unsubscribe = window.electronAPI.settings.onLocaleChanged((nextSettings) => {
      setSettings(nextSettings);
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    applyDocumentLocale(settings.locale);
  }, [settings.locale]);

  const value = useMemo(() => ({
    locale: settings.locale,
    source: settings.source,
    t: createTranslator(settings.locale),
    setLocale: async (locale: SupportedLocale) => {
      const nextSettings = await window.electronAPI.settings.setLocale(locale);
      setSettings(nextSettings);
    }
  }), [settings.locale, settings.source]);

  return (
    <RendererI18nContext.Provider value={value}>
      {children}
    </RendererI18nContext.Provider>
  );
}
