import { createContext } from "react";
import { createTranslator, DEFAULT_LOCALE, type LocaleSettings, type SupportedLocale, type TranslateFunction } from "../../shared/i18n";

export type RendererI18nContextValue = {
  locale: SupportedLocale;
  source: LocaleSettings["source"];
  t: TranslateFunction;
  setLocale: (locale: SupportedLocale) => Promise<void>;
};

export const defaultRendererI18nContextValue: RendererI18nContextValue = {
  locale: DEFAULT_LOCALE,
  source: "default",
  t: createTranslator(DEFAULT_LOCALE),
  setLocale: async () => undefined
};

export const RendererI18nContext = createContext<RendererI18nContextValue>(defaultRendererI18nContextValue);
