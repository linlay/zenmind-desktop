import type { SVGProps } from "react";
import { APP_ICON_ASSET_FILENAMES } from "../../shared/app-icon-assets";
import { useI18n } from "../i18n/useI18n";

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
  | "login"
  | "logout"
  | "archive"
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

export type SidebarActionIconKind =
  | "sidebar_left"
  | "sidebar_right"
  | "back"
  | "forward"
  | "sort"
  | "new_project"
  | "new_chat"
  | "more_actions"
  | "double_check"
  | "close"

type SidebarIllustrationProps = {
  kind: SidebarIllustrationKind;
  className?: string;
};

type SidebarActionIconProps = {
  kind: SidebarActionIconKind;
  className?: string;
};

function getSidebarIconClassName(kind: SidebarIllustrationKind, className?: string) {
  return [
    "sidebar-illustration",
    `sidebar-illustration-${kind}`,
    kind === "futures" ? "sidebar-illustration-kanban" : "",
    kind === "schedule" ? "sidebar-illustration-automation" : "",
    className ?? ""
  ]
    .filter(Boolean)
    .join(" ");
}

function createSidebarIconProps(
  kind: SidebarIllustrationKind,
  className?: string
): SVGProps<SVGSVGElement> {
  return {
    className: getSidebarIconClassName(kind, className),
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": true,
    focusable: "false"
  };
}

function getSidebarActionIconClassName(kind: SidebarActionIconKind, className?: string) {
  return [
    "sidebar-action-icon",
    `sidebar-action-icon-${kind}`,
    className ?? ""
  ]
    .filter(Boolean)
    .join(" ");
}

function createSidebarActionIconProps(
  kind: SidebarActionIconKind,
  className?: string
): SVGProps<SVGSVGElement> {
  return {
    className: getSidebarActionIconClassName(kind, className),
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": true,
    focusable: "false"
  };
}

export function BrandMark({ className, ariaLabel }: BrandMarkProps) {
  const { t } = useI18n();
  return (
    <img
      src={`./${APP_ICON_ASSET_FILENAMES.brandMark}`}
      alt={ariaLabel ?? t("brandMark.alt")}
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

export function SidebarActionIcon({ kind, className }: SidebarActionIconProps) {
  const iconProps = createSidebarActionIconProps(kind, className);

  switch (kind) {
    case "sidebar_left":
      return (
        <svg {...iconProps}>
          <rect x="3" y="3" width="18" height="18" rx="3.5" />
          <line x1="9" y1="3" x2="9" y2="21" />
        </svg>
      );
    case "sidebar_right":
      return (
        <svg {...iconProps}>
          <rect x="3" y="3" width="18" height="18" rx="3.5" />
          <line x1="8" y1="9" x2="16" y2="9" />
          <line x1="8" y1="12" x2="16" y2="12" />
          <line x1="8" y1="15" x2="13" y2="15" />
        </svg>
      );
    case "back":
      return (
        <svg {...iconProps}>
          <polyline points="14 17 9 12 14 7" />
        </svg>
      );
    case "forward":
      return (
        <svg {...iconProps}>
          <polyline points="10 17 15 12 10 7" />
        </svg>
      );
    case "sort":
      return (
        <svg {...iconProps}>
          <path d="M6 5v14" />
          <path d="M3.5 15.5 6 18l2.5-2.5" />
          <path d="M12 7h8" />
          <path d="M12 12h6" />
          <path d="M12 17h4" />
        </svg>
      );
    case "new_project":
      return (
        <svg {...iconProps}>
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      );
    case "new_chat":
      return (
        <svg {...iconProps}>
          <path d="M12 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6" />
          <path d="M20 3.5a1.5 1.5 0 0 0-2 0l-9 9V15h2.5l9-9a1.5 1.5 0 0 0 0-2z" />
          <line x1="16.5" y1="5" x2="19" y2="7.5" />
        </svg>
      );
    case "more_actions":
      return (
        <svg {...iconProps}>
          <circle cx="6" cy="12" r="1.75" fill="currentColor" stroke="none" />
          <circle cx="12" cy="12" r="1.75" fill="currentColor" stroke="none" />
          <circle cx="18" cy="12" r="1.75" fill="currentColor" stroke="none" />
        </svg>
      );
    case "double_check":
      return (
        <svg {...iconProps}>
          <path d="M2 13.5l3.5 3.5 6-6" />
          <path d="M9 13.5l3.5 3.5 7.5-7.5" />
        </svg>
      );
    case "close":
      return (
        <svg {...iconProps}>
          <line x1="6" y1="6" x2="18" y2="18" />
          <line x1="18" y1="6" x2="6" y2="18" />
        </svg>
      );
    default:
      return (
        <svg {...iconProps}>
          <circle cx="12" cy="12" r="10" />
        </svg>
      );
  }
}

export function SidebarIllustration({ kind, className }: SidebarIllustrationProps) {
  const iconProps = createSidebarIconProps(kind, className);

  switch (kind) {
    case "agent":
    case "assistant":
      return (
        <svg {...iconProps}>
          <rect x="3" y="7" width="18" height="13" rx="3.5" />
          <path d="M12 7V4" />
          <circle cx="12" cy="3" r="1" fill="currentColor" stroke="none" />
          <path d="M1 13h2M21 13h2" />
          <circle cx="8" cy="12" r="1.5" fill="currentColor" stroke="none" />
          <circle cx="16" cy="12" r="1.5" fill="currentColor" stroke="none" />
          <path d="M9 16h6" />
        </svg>
      );
    case "login":
    case "custom":
      return (
        <svg {...iconProps}>
          <path d="M19 21v-1.5a4.5 4.5 0 0 0-4.5-4.5h-5A4.5 4.5 0 0 0 5 19.5V21" />
          <circle cx="12" cy="7.5" r="4" />
        </svg>
      );
    case "logout":
      return (
        <svg {...iconProps}>
          <path d="M19 21v-1.5a4.5 4.5 0 0 0-4.5-4.5h-5A4.5 4.5 0 0 0 5 19.5V21" />
          <circle cx="12" cy="7.5" r="4" />
          <line x1="3" y1="3" x2="21" y2="21" />
        </svg>
      );
    case "archive":
      return (
        <svg {...iconProps}>
          <rect x="3" y="4" width="18" height="5" rx="1.5" />
          <path d="M4 9v10c0 1.66 1.34 3 3 3h10c1.66 0 3-1.34 3-3V9" />
          <line x1="9" y1="13" x2="15" y2="13" />
        </svg>
      );
    case "service":
      return (
        <svg {...iconProps}>
          <rect x="3" y="3" width="18" height="18" rx="5" />
          <path d="M8 9l3 3-3 3" />
          <line x1="13" y1="15" x2="16" y2="15" />
        </svg>
      );
    case "market":
      return (
        <svg {...iconProps}>
          <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
          <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
          <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
          <path d="M17 13.5v7M13.5 17h7" />
        </svg>
      );
    case "help":
      return (
        <svg {...iconProps}>
          <circle cx="12" cy="12" r="10" />
          <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
          <circle cx="12" cy="17" r="1" fill="currentColor" stroke="none" />
        </svg>
      );
    case "settings":
      return (
        <svg {...iconProps}>
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      );
    case "futures":
      return (
        <svg {...iconProps}>
          <rect
            className="sidebar-illustration-kanban-frame"
            x="3"
            y="3"
            width="18"
            height="18"
            rx="5"
          />
          <rect
            className="sidebar-illustration-kanban-lane sidebar-illustration-kanban-lane-blue"
            x="7"
            y="7"
            width="2.5"
            height="10"
            rx="1"
          />
          <rect
            className="sidebar-illustration-kanban-lane sidebar-illustration-kanban-lane-green"
            x="11"
            y="7"
            width="2.5"
            height="7"
            rx="1"
          />
          <rect
            className="sidebar-illustration-kanban-lane sidebar-illustration-kanban-lane-amber"
            x="15"
            y="7"
            width="2.5"
            height="4"
            rx="1"
          />
        </svg>
      );
    case "schedule":
      return (
        <svg {...iconProps}>
          <circle className="sidebar-illustration-automation-ring" cx="12" cy="12" r="10" />
          <path className="sidebar-illustration-automation-hand" d="M12 6v6l4 2" />
        </svg>
      );
    case "appearance":
      return (
        <svg {...iconProps}>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 3a6.5 6.5 0 0 0 0 18 7.5 7.5 0 0 1 0-18z" />
        </svg>
      );
    case "control":
      return (
        <svg {...iconProps}>
          <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3" />
          <circle cx="4" cy="12" r="2" />
          <circle cx="12" cy="10" r="2" />
          <circle cx="20" cy="14" r="2" />
        </svg>
      );
    case "website":
      return (
        <svg {...iconProps}>
          <circle cx="12" cy="12" r="10" />
          <path d="M2 12h20" />
          <path d="M12 2a15.3 15.3 0 0 1 0 20M12 2a15.3 15.3 0 0 0 0 20" />
        </svg>
      );
    case "about":
      return (
        <svg {...iconProps}>
          <circle cx="12" cy="12" r="10" />
          <path d="M12 11v6" />
          <circle cx="12" cy="7" r="1" fill="currentColor" stroke="none" />
        </svg>
      );
    case "memory":
      return (
        <svg {...iconProps}>
          <rect x="6" y="6" width="12" height="12" rx="2" />
          <rect x="10" y="10" width="4" height="4" rx="1" />
          <path d="M6 2v3M10 2v3M14 2v3M18 2v3M6 19v3M10 19v3M14 19v3M18 19v3M2 6h3M2 10h3M2 14h3M2 18h3M19 6h3M19 10h3M19 14h3M19 18h3" />
        </svg>
      );
    case "autumn":
      return (
        <svg {...iconProps}>
          <rect x="3" y="5" width="18" height="16" rx="3" />
          <path d="M16 3v4M8 3v4M3 10h18" />
          <path d="M9 15h6" />
        </svg>
      );
    case "sidebar-assistant-open":
      return (
        <svg {...iconProps}>
          <rect x="3" y="4" width="18" height="16" rx="3" />
          <path d="M9 4v16M13 8h4M13 12h3M13 16h4" />
        </svg>
      );
    case "sidebar-assistant-closed":
      return (
        <svg {...iconProps}>
          <rect x="3" y="4" width="18" height="16" rx="3" />
          <path d="M8 8h8M8 12h6M8 16h8" />
        </svg>
      );
    default:
      return (
        <svg {...iconProps}>
          <circle cx="12" cy="12" r="10" />
        </svg>
      );
  }
}
