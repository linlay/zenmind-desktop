import { normalizeLocale } from "./locales";
import type { LocaleSettings } from "./types";

const INITIAL_LOCALE_ARG_PREFIX = "--zenmind-initial-locale=";
const INITIAL_LOCALE_SOURCE_ARG_PREFIX = "--zenmind-initial-locale-source=";
const LOCALE_SOURCES: Array<LocaleSettings["source"]> = ["stored", "system", "default"];

function readArgumentValue(argv: readonly string[], prefix: string) {
  return argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? null;
}

function normalizeLocaleSource(value: string | null): LocaleSettings["source"] | null {
  return LOCALE_SOURCES.includes(value as LocaleSettings["source"])
    ? value as LocaleSettings["source"]
    : null;
}

export function createInitialLocaleArguments(settings: LocaleSettings): string[] {
  return [
    `${INITIAL_LOCALE_ARG_PREFIX}${settings.locale}`,
    `${INITIAL_LOCALE_SOURCE_ARG_PREFIX}${settings.source}`
  ];
}

export function readInitialLocaleSettingsFromArgv(argv: readonly string[]): LocaleSettings | null {
  const locale = normalizeLocale(readArgumentValue(argv, INITIAL_LOCALE_ARG_PREFIX));
  const source = normalizeLocaleSource(readArgumentValue(argv, INITIAL_LOCALE_SOURCE_ARG_PREFIX));

  if (!locale || !source) {
    return null;
  }

  return { locale, source };
}
