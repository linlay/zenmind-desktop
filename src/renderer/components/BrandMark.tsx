import { CUSTOM_SIDEBAR_ICONS } from "../../shared/custom-sidebar-icons";
import { APP_ICON_ASSET_FILENAMES } from "../../shared/app-icon-assets";
import agentIcon from "../assets/sidebar-icons/agent.svg";
import appearanceIcon from "../assets/sidebar-icons/appearance.svg";
import assistantIcon from "../assets/sidebar-icons/assistant.svg";
import autumnIcon from "../assets/sidebar-icons/autumn.svg";
import controlIcon from "../assets/sidebar-icons/control.svg";
import customIcon from "../assets/sidebar-icons/custom.svg";
import folderIcon from "../assets/sidebar-icons/folder.svg";
import futuresIcon from "../assets/sidebar-icons/futures.svg";
import helpIcon from "../assets/sidebar-icons/help.svg";
import marketIcon from "../assets/sidebar-icons/market.svg";
import memoryIcon from "../assets/sidebar-icons/memory.svg";
import navigationIcon from "../assets/sidebar-icons/navigation.svg";
import petIcon from "../assets/sidebar-icons/pet.svg";
import scheduleIcon from "../assets/sidebar-icons/schedule.svg";
import serviceIcon from "../assets/sidebar-icons/service.svg";
import settingsIcon from "../assets/sidebar-icons/settings.svg";
import sidebarAssistantClosedIcon from "../assets/sidebar-icons/sidebar-assistant-closed.svg";
import sidebarAssistantOpenIcon from "../assets/sidebar-icons/sidebar-assistant-open.svg";
import websiteIcon from "../assets/sidebar-icons/website.svg";

type BrandMarkProps = {
  className?: string;
};

export type SidebarIllustrationKind =
  | "control"
  | "assistant"
  | "agent"
  | "appearance"
  | "market"
  | "help"
  | "settings"
  | "service"
  | "futures"
  | "autumn"
  | "custom"
  | "folder"
  | "memory"
  | "navigation"
  | "pet"
  | "schedule"
  | "sidebar-assistant-closed"
  | "sidebar-assistant-open"
  | "website";

type SidebarIllustrationProps = {
  kind: SidebarIllustrationKind;
  className?: string;
};

const customSidebarIconDataUris = new Map<string, string>();

const sidebarIllustrationSources: Record<SidebarIllustrationKind, string> = {
  agent: agentIcon,
  appearance: appearanceIcon,
  assistant: assistantIcon,
  autumn: autumnIcon,
  control: controlIcon,
  custom: customIcon,
  folder: folderIcon,
  futures: futuresIcon,
  help: helpIcon,
  market: marketIcon,
  memory: memoryIcon,
  navigation: navigationIcon,
  pet: petIcon,
  schedule: scheduleIcon,
  service: serviceIcon,
  settings: settingsIcon,
  "sidebar-assistant-closed": sidebarAssistantClosedIcon,
  "sidebar-assistant-open": sidebarAssistantOpenIcon,
  website: websiteIcon
};

function getCustomSidebarIconDataUri(iconId: string) {
  const cached = customSidebarIconDataUris.get(iconId);
  if (cached) {
    return cached;
  }

  const icon = CUSTOM_SIDEBAR_ICONS.find((candidate) => candidate.id === iconId) ?? CUSTOM_SIDEBAR_ICONS[0];
  const dataUri = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(icon.svg)}`;
  customSidebarIconDataUris.set(iconId, dataUri);
  return dataUri;
}

export function BrandMark({ className }: BrandMarkProps) {
  return (
    <img
      src={`./${APP_ICON_ASSET_FILENAMES.brandIcon}`}
      alt="品牌标识"
      className={className}
      style={{ width: "100%", height: "100%", objectFit: "contain", borderRadius: 8 }}
      onError={(event) => {
        (event.currentTarget as HTMLImageElement).style.visibility = "hidden";
      }}
    />
  );
}

export function CustomSidebarIcon({ iconId, className }: { iconId: string; className?: string }) {
  return <img src={getCustomSidebarIconDataUri(iconId)} alt="" aria-hidden="true" className={className} />;
}

export function SidebarIllustration({ kind, className }: SidebarIllustrationProps) {
  return <img src={sidebarIllustrationSources[kind]} alt="" aria-hidden="true" className={className} />;
}
