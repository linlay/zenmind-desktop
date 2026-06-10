import type { SettingsSectionId } from "./settings-sections";

const SETTINGS_ROUTE_PREFIX = "/settings";
const LEGACY_SETTINGS_SECTION_ALIASES: Record<string, SettingsSectionId> = {
  debug: "about",
  runtimeReset: "about"
};

export function buildSettingsSectionPath(sectionId: SettingsSectionId): string {
  return `${SETTINGS_ROUTE_PREFIX}/${sectionId}`;
}

export function isSettingsRoute(pathname: string): boolean {
  return pathname === SETTINGS_ROUTE_PREFIX || pathname.startsWith(`${SETTINGS_ROUTE_PREFIX}/`);
}

export function parseSettingsSectionId(pathname: string): SettingsSectionId | null {
  if (!pathname.startsWith(`${SETTINGS_ROUTE_PREFIX}/`)) {
    return null;
  }

  const sectionId = pathname.slice(`${SETTINGS_ROUTE_PREFIX}/`.length).split("/")[0]?.trim();
  if (!sectionId) {
    return null;
  }

  return LEGACY_SETTINGS_SECTION_ALIASES[sectionId] ?? (sectionId as SettingsSectionId);
}

export function resolveSettingsSectionId(
  pathname: string,
  visibleSectionIds: readonly SettingsSectionId[]
): SettingsSectionId | null {
  const defaultSectionId = visibleSectionIds[0] ?? null;
  if (!defaultSectionId) {
    return null;
  }

  const parsedSectionId = parseSettingsSectionId(pathname);
  if (!parsedSectionId) {
    return defaultSectionId;
  }

  return visibleSectionIds.includes(parsedSectionId) ? parsedSectionId : defaultSectionId;
}

export function getDefaultSettingsSectionPath(visibleSectionIds: readonly SettingsSectionId[]): string {
  const sectionId = visibleSectionIds[0];
  if (!sectionId) {
    return SETTINGS_ROUTE_PREFIX;
  }

  return buildSettingsSectionPath(sectionId);
}
