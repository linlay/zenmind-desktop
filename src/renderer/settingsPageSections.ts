export type SettingsSectionId =
  | "appearance"
  | "navigation"
  | "quickAssistant"
  | "sideAssistant"
  | "desktopPet"
  | "embeddedWebsites"
  | "dataRoot"
  | "memory";

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
      label: "外观",
      description: "切换主题模式并调整桌面工作台的界面风格。",
      layout: "measure",
      visible: true
    },
    {
      id: "navigation",
      label: "导航栏",
      description: "管理左侧主导航页签的显示顺序。",
      layout: "wide",
      visible: true
    },
    {
      id: "quickAssistant",
      label: "快捷助手",
      description: "配置 Option+Space 唤起的快捷助手默认行为。",
      layout: "measure",
      visible: true
    },
    {
      id: "sideAssistant",
      label: "侧边助手",
      description: "配置各一级页面是否显示侧边助手以及默认智能体。",
      layout: "measure",
      visible: true
    },
    {
      id: "desktopPet",
      label: "宠物助手",
      description: "管理桌面宠物的开关、形象和绑定智能体。",
      layout: "measure",
      visible: desktopPetSupported
    },
    {
      id: "embeddedWebsites",
      label: "内嵌网站",
      description: "固定常用网页入口，并管理其智能体增强配置。",
      layout: "wide",
      visible: true
    },
    {
      id: "dataRoot",
      label: "数据目录",
      description: "查看应用本地数据目录位置和存储说明。",
      layout: "measure",
      visible: isWindows
    },
    {
      id: "memory",
      label: "助手记忆",
      description: "管理本地记忆召回、自动学习和存储内容。",
      layout: "wide",
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
