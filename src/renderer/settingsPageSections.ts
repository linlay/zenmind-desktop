export type SettingsSectionId =
  | "appearance"
  | "navigation"
  | "quickAssistant"
  | "desktopPet"
  | "embeddedWebsites"
  | "dataRoot"
  | "debug"
  | "memory"
  | "about";

export type SettingsSectionLayout = "measure" | "wide";

export type SettingsSectionDefinition = {
  id: SettingsSectionId;
  label: string;
  description: string;
  layout: SettingsSectionLayout;
  visible: boolean;
};

export function createSettingsSectionDefinitions({
  isWindows,
  desktopPetSupported
}: {
  isWindows: boolean;
  desktopPetSupported: boolean;
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
      id: "desktopPet",
      label: "desktopPet",
      description: "",
      layout: "measure",
      visible: desktopPetSupported
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
