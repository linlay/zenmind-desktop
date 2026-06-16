export type SettingsSectionId =
  | "general"
  | "appearance"
  | "kanban"
  | "assistant"
  | "market"
  | "control"
  | "tunnelHub"
  | "navigation"
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
