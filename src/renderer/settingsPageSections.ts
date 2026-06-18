import type { SettingsSectionDefinition } from "../../shared/settings-sections";
import type { TranslationKey } from "../../shared/i18n";

export type {
  SettingsSectionDefinition,
  SettingsSectionGroupId,
  SettingsSectionId,
  SettingsSectionLayout
} from "../../shared/settings-sections";

export function createSettingsSectionDefinitions({
  isWindows,
  desktopPetSupported = true,
  debugVisible = false
}: {
  isWindows: boolean;
  desktopPetSupported?: boolean;
  debugVisible?: boolean;
}): SettingsSectionDefinition[] {
  return [
    {
      id: "general",
      group: "personal",
      label: "general",
      description: "",
      layout: "measure",
      visible: true
    },
    {
      id: "appearance",
      group: "personal",
      label: "appearance",
      description: "",
      layout: "measure",
      visible: true
    },
    {
      id: "assistant",
      group: "personal",
      label: "assistant",
      description: "",
      layout: "measure",
      visible: true
    },
    {
      id: "navigation",
      group: "personal",
      label: "navigation",
      description: "",
      layout: "wide",
      visible: true
    },
    {
      id: "kanban",
      group: "integrations",
      label: "kanban",
      description: "",
      layout: "measure",
      visible: true
    },
    {
      id: "market",
      group: "integrations",
      label: "market",
      description: "",
      layout: "measure",
      visible: true
    },
    {
      id: "control",
      group: "integrations",
      label: "control",
      description: "",
      layout: "measure",
      visible: true
    },
    {
      id: "tunnelHub",
      group: "integrations",
      label: "tunnelHub",
      description: "",
      layout: "measure",
      visible: true
    },
    {
      id: "embeddedWebs",
      group: "integrations",
      label: "embeddedWebs",
      description: "",
      layout: "wide",
      visible: true
    },
    {
      id: "dataRoot",
      group: "system",
      label: "dataRoot",
      description: "",
      layout: "measure",
      visible: isWindows
    },
    {
      id: "about",
      group: "system",
      label: "about",
      description: "",
      layout: "measure",
      visible: true
    },
    {
      id: "debug",
      group: "system",
      label: "debug",
      description: "",
      layout: "measure",
      visible: debugVisible
    },
    {
      id: "memory",
      group: "system",
      label: "memory",
      description: "",
      layout: "wide",
      visible: false
    }
  ];
}

export function getVisibleSettingsSections(definitions: SettingsSectionDefinition[]) {
  return definitions.filter((definition) => definition.visible);
}

export function getDefaultSettingsSectionId(definitions: SettingsSectionDefinition[]) {
  return getVisibleSettingsSections(definitions)[0]?.id ?? null;
}

const SETTINGS_SECTION_LABEL_KEYS: Record<
  SettingsSectionDefinition["id"],
  { label: TranslationKey; description: TranslationKey }
> = {
  general: { label: "settings.general.label", description: "settings.general.description" },
  appearance: { label: "settings.appearance.label", description: "settings.appearance.description" },
  kanban: { label: "settings.kanban.label", description: "settings.kanban.description" },
  assistant: { label: "settings.assistant.label", description: "settings.assistant.description" },
  market: { label: "settings.market.label", description: "settings.market.description" },
  control: { label: "settings.control.label", description: "settings.control.description" },
  tunnelHub: { label: "settings.tunnelHub.label", description: "settings.tunnelHub.description" },
  navigation: { label: "settings.navigation.label", description: "settings.navigation.description" },
  embeddedWebs: { label: "settings.embeddedWebs.label", description: "settings.embeddedWebs.description" },
  dataRoot: { label: "settings.dataRoot.label", description: "settings.dataRoot.description" },
  memory: { label: "settings.memory.label", description: "settings.memory.description" },
  about: { label: "settings.about.label", description: "settings.about.description" },
  debug: { label: "settings.debug.label", description: "settings.debug.description" }
};

export function localizeSettingsSectionDefinitions(
  definitions: SettingsSectionDefinition[],
  t: (key: TranslationKey) => string
): SettingsSectionDefinition[] {
  return definitions.map((definition) => {
    const keys = SETTINGS_SECTION_LABEL_KEYS[definition.id];
    return {
      ...definition,
      label: t(keys.label),
      description: t(keys.description)
    };
  });
}

export function buildLocalizedSettingsSections({
  isWindows,
  desktopPetSupported,
  debugVisible,
  t
}: {
  isWindows: boolean;
  desktopPetSupported?: boolean;
  debugVisible?: boolean;
  t: (key: TranslationKey) => string;
}): SettingsSectionDefinition[] {
  return localizeSettingsSectionDefinitions(
    createSettingsSectionDefinitions({ isWindows, desktopPetSupported, debugVisible }),
    t
  );
}
