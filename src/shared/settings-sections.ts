export type SettingsSectionId =
  | "appearance"
  | "kanban"
  | "desktopPet"
  | "market"
  | "control"
  | "tunnelHub"
  | "navigation"
  | "quickAssistant"
  | "embeddedWebs"
  | "dataRoot"
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
