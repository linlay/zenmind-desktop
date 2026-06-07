import { APP_ICON_ASSET_FILENAMES } from "../../shared/app-icon-assets";
import aboutIcon from "../assets/sidebar-icons/about.svg";
import agentIcon from "../assets/sidebar-icons/agent.svg";
import appearanceIcon from "../assets/sidebar-icons/appearance.svg";
import assistantIcon from "../assets/sidebar-icons/assistant.svg";
import autumnIcon from "../assets/sidebar-icons/autumn.svg";
import controlIcon from "../assets/sidebar-icons/control.svg";
import customIcon from "../assets/sidebar-icons/custom.svg";
import futuresIcon from "../assets/sidebar-icons/futures.svg";
import helpIcon from "../assets/sidebar-icons/help.svg";
import marketIcon from "../assets/sidebar-icons/market.svg";
import memoryIcon from "../assets/sidebar-icons/memory.svg";
import scheduleIcon from "../assets/sidebar-icons/schedule.svg";
import serviceIcon from "../assets/sidebar-icons/service.svg";
import settingsIcon from "../assets/sidebar-icons/settings.svg";
import sidebarAssistantClosedIcon from "../assets/sidebar-icons/sidebar-assistant-closed.svg";
import sidebarAssistantOpenIcon from "../assets/sidebar-icons/sidebar-assistant-open.svg";
import websiteIcon from "../assets/sidebar-icons/website.svg";

type BrandMarkProps = {
  className?: string;
  ariaLabel?: string;
};

export type SidebarIllustrationKind =
  | "about"
  | "appearance"
  | "control"
  | "assistant"
  | "agent"
  | "market"
  | "help"
  | "settings"
  | "service"
  | "futures"
  | "autumn"
  | "custom"
  | "memory"
  | "schedule"
  | "sidebar-assistant-closed"
  | "sidebar-assistant-open"
  | "website";

type SidebarIllustrationProps = {
  kind: SidebarIllustrationKind;
  className?: string;
};

const sidebarIllustrationSources: Record<SidebarIllustrationKind, string> = {
  about: aboutIcon,
  agent: agentIcon,
  appearance: appearanceIcon,
  assistant: assistantIcon,
  autumn: autumnIcon,
  control: controlIcon,
  custom: customIcon,
  futures: futuresIcon,
  help: helpIcon,
  market: marketIcon,
  memory: memoryIcon,
  schedule: scheduleIcon,
  service: serviceIcon,
  settings: settingsIcon,
  "sidebar-assistant-closed": sidebarAssistantClosedIcon,
  "sidebar-assistant-open": sidebarAssistantOpenIcon,
  website: websiteIcon
};

export function BrandMark({ className, ariaLabel }: BrandMarkProps) {
  return (
    <img
      src={`./${APP_ICON_ASSET_FILENAMES.brandIcon}`}
      alt={ariaLabel ?? "品牌标识"}
      className={className}
      style={{
        width: "var(--brand-mark-size, 100%)",
        height: "var(--brand-mark-size, 100%)",
        objectFit: "contain",
        borderRadius: 8
      }}
      onError={(event) => {
        (event.currentTarget as HTMLImageElement).style.visibility = "hidden";
      }}
    />
  );
}

export function SidebarIllustration({ kind, className }: SidebarIllustrationProps) {
  return <img src={sidebarIllustrationSources[kind]} alt="" aria-hidden="true" className={className} />;
}
