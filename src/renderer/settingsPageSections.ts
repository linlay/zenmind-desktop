import type { SettingsSectionDefinition } from "../../shared/settings-sections";
import type { TranslationKey } from "../../shared/i18n";

export type {
  SettingsSectionDefinition,
  SettingsSectionId,
  SettingsSectionLayout
} from "../../shared/settings-sections";

export function createSettingsSectionDefinitions({
  isWindows
}: {
  isWindows: boolean;
  desktopPetSupported?: boolean;
}): SettingsSectionDefinition[] {
  return [
    {
      id: "appearance",
      label: "appearance",
      description: "",
      layout: "measure",
      visible: true
    },
    {
      id: "control",
      label: "control",
      description: "",
      layout: "measure",
      visible: true
    },
    {
      id: "navigation",
      label: "navigation",
      description: "",
      layout: "wide",
      visible: true
    },
    {
      id: "quickAssistant",
      label: "quickAssistant",
      description: "",
      layout: "measure",
      visible: true
    },
    {
      id: "embeddedWebsites",
      label: "embeddedWebsites",
      description: "",
      layout: "wide",
      visible: true
    },
    {
      id: "dataRoot",
      label: "dataRoot",
      description: "",
      layout: "measure",
      visible: isWindows
    },
    {
      id: "debug",
      label: "debug",
      description: "",
      layout: "measure",
      visible: true
    },
    {
      id: "memory",
      label: "memory",
      description: "",
      layout: "wide",
      visible: false
    },
    {
      id: "about",
      label: "about",
      description: "",
      layout: "measure",
      visible: true
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
  appearance: { label: "settings.appearance.label", description: "settings.appearance.description" },
  control: { label: "settings.control.label", description: "settings.control.description" },
  navigation: { label: "settings.navigation.label", description: "settings.navigation.description" },
  quickAssistant: { label: "settings.quickAssistant.label", description: "settings.quickAssistant.description" },
  embeddedWebsites: { label: "settings.embeddedWebsites.label", description: "settings.embeddedWebsites.description" },
  dataRoot: { label: "settings.dataRoot.label", description: "settings.dataRoot.description" },
  debug: { label: "settings.debug.label", description: "settings.debug.description" },
  memory: { label: "settings.memory.label", description: "settings.memory.description" },
  about: { label: "settings.about.label", description: "settings.about.description" }
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
  t
}: {
  isWindows: boolean;
  t: (key: TranslationKey) => string;
}): SettingsSectionDefinition[] {
  return localizeSettingsSectionDefinitions(createSettingsSectionDefinitions({ isWindows }), t);
}
