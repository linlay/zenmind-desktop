import { DEFAULT_LOCALE, type SupportedLocale } from "./locales";
import { getDictionary, type TranslationKey } from "./messages";
import type { TranslateFunction, TranslateParams } from "./types";

const PLACEHOLDER_PATTERN = /\{([A-Za-z0-9_.-]+)\}/gu;

function shouldWarn() {
  return typeof process !== "undefined" && process.env.NODE_ENV !== "production";
}

function warn(message: string) {
  if (shouldWarn()) {
    console.warn(message);
  }
}

export function formatMessage(template: string, params: TranslateParams = {}) {
  return template.replace(PLACEHOLDER_PATTERN, (match, name: string) => {
    if (!(name in params)) {
      warn(`Missing i18n parameter "${name}" for message "${template}".`);
      return match;
    }
    const value = params[name];
    return value === null || value === undefined ? "" : String(value);
  });
}

export function createTranslator(locale: SupportedLocale): TranslateFunction {
  const dictionary = getDictionary(locale);
  const fallbackDictionary = getDictionary(DEFAULT_LOCALE);
  return (key, params) => {
    const template = dictionary[key] ?? fallbackDictionary[key];
    if (!template) {
      warn(`Missing i18n key "${key}".`);
      return key;
    }
    return formatMessage(template, params);
  };
}

export function translate(locale: SupportedLocale, key: TranslationKey, params?: TranslateParams) {
  return createTranslator(locale)(key, params);
}
