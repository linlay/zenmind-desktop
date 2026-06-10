export type SettingsSectionId =
  | "appearance"
  | "control"
  | "navigation"
  | "quickAssistant"
  | "embeddedWebsites"
  | "dataRoot"
  | "debug"
  | "memory"
  | "runtimeReset"
  | "about";

export type SettingsSectionLayout = "measure" | "wide";

export type SettingsSectionDefinition = {
  id: SettingsSectionId;
  label: string;
  description: string;
  layout: SettingsSectionLayout;
  visible: boolean;
};
