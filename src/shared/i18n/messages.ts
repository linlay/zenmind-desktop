import { enUSMessages } from "./dictionaries/enUS";
import { zhCNMessages } from "./dictionaries/zhCN";
import type { SupportedLocale } from "./locales";

export const i18nMessages = {
  "zh-CN": zhCNMessages,
  "en-US": enUSMessages
} as const;

export type BaseMessages = typeof zhCNMessages;
export type TranslationKey = Extract<keyof BaseMessages, string>;
export type I18nDictionary = Record<TranslationKey, string>;

export function getDictionary(locale: SupportedLocale): I18nDictionary {
  return i18nMessages[locale];
}
