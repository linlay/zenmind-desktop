export type SettingsSectionId =
  | "usage"
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
  | "about"
  | "debug";

export type SettingsSectionLayout = "measure" | "wide";
export type SettingsSectionGroupId = "personal" | "integrations" | "system";

export type SettingsSectionDefinition = {
  id: SettingsSectionId;
  group: SettingsSectionGroupId;
  label: string;
  description: string;
  layout: SettingsSectionLayout;
  visible: boolean;
};
