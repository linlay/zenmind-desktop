export type SettingsSectionId =
  | "appearance"
  | "control"
  | "tunnelHub"
  | "navigation"
  | "quickAssistant"
  | "embeddedWebsites"
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
