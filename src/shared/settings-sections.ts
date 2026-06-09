export type SettingsSectionId =
  | "appearance"
  | "control"
  | "navigation"
  | "quickAssistant"
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
