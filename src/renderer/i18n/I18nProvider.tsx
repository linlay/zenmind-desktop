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

export function I18nProvider({ children }: I18nProviderProps) {
  const [settings, setSettings] = useState<LocaleSettings>(fallbackSettings);

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
