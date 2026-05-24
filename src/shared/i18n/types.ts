import type { SupportedLocale } from "./locales";
import type { I18nDictionary, TranslationKey } from "./messages";

export type { SupportedLocale, I18nDictionary, TranslationKey };

export type LocaleSettings = {
  locale: SupportedLocale;
  source: "stored" | "system" | "default";
};

export type TranslateParams = Record<string, string | number | boolean | null | undefined>;

export type TranslateFunction = (
  key: TranslationKey,
  params?: TranslateParams
) => string;
