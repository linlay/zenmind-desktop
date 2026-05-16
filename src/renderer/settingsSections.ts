import type { SidebarIllustrationKind } from "./components/BrandMark";

export type SettingsSectionId =
  | "appearance"
  | "navigation"
  | "quickAssistant"
  | "sideAssistant"
  | "desktopPet"
  | "embeddedWebsites"
  | "dataRoot"
  | "memory";

export type SettingsSectionDefinition = {
  id: SettingsSectionId;
  label: string;
  description: string;
  icon: SidebarIllustrationKind;
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
      icon: "appearance",
      visible: true
    },
    {
      id: "navigation",
      label: "导航栏",
      description: "管理左侧主导航页签的显示顺序。",
      icon: "navigation",
      visible: true
    },
    {
      id: "quickAssistant",
      label: "快捷助手",
      description: "配置 Option+Space 唤起的快捷助手默认行为。",
      icon: "assistant",
      visible: true
    },
    {
      id: "sideAssistant",
      label: "侧边助手",
      description: "配置各一级页面是否显示侧边助手以及默认智能体。",
      icon: "sidebar-assistant-closed",
      visible: true
    },
    {
      id: "desktopPet",
      label: "宠物助手",
      description: "管理桌面宠物的开关、形象和绑定智能体。",
      icon: "pet",
      visible: desktopPetSupported
    },
    {
      id: "embeddedWebsites",
      label: "内嵌网站",
      description: "固定常用网页入口，并管理其智能体增强配置。",
      icon: "website",
      visible: true
    },
    {
      id: "dataRoot",
      label: "数据目录",
      description: "查看应用本地数据目录位置和存储说明。",
      icon: "folder",
      visible: isWindows
    },
    {
      id: "memory",
      label: "助手记忆",
      description: "管理本地记忆召回、自动学习和存储内容。",
      icon: "memory",
      visible: true
    }
  ];
}

export function getVisibleSettingsSections(definitions: SettingsSectionDefinition[]) {
  return definitions.filter((definition) => definition.visible);
}

export function normalizeSettingsSectionId(
  sectionId: string | null | undefined,
  definitions: SettingsSectionDefinition[]
): SettingsSectionId | null {
  const visibleSections = getVisibleSettingsSections(definitions);
  const fallbackSection = visibleSections[0];

  if (!fallbackSection) {
    return null;
  }

  const matchedSection = visibleSections.find((definition) => definition.id === sectionId);
  return matchedSection?.id ?? fallbackSection.id;
}

export function readSettingsSectionId(search: string) {
  return new URLSearchParams(search).get("section");
}

export function buildSettingsSectionPath(sectionId: SettingsSectionId) {
  return `/settings?section=${sectionId}`;
}
