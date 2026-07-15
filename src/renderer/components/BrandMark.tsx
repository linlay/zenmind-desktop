import type { SVGProps } from "react";
import { APP_ICON_ASSET_FILENAMES } from "../../shared/app-icon-assets";
import { useI18n } from "../i18n/useI18n";

type BrandMarkProps = {
  className?: string;
  ariaLabel?: string;
};

export type SidebarIllustrationKind =
  | "assistant"
  | "agent"
  | "chat"
  | "project"
  | "login"
  | "logout"
  | "archive"
  | "market"
  | "help"
  | "settings"
  | "service"
  | "futures"
  | "schedule"
  | "website";

/**
 * The primary sidebar has two purpose-built icon families. The compact family
 * is used beside the expanded labels; the rail family is only for the 28px
 * collapsed navigation targets.
 */
export type SidebarIllustrationVariant = "compact" | "rail";

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
  | "close";

type SidebarIllustrationProps = {
  kind: SidebarIllustrationKind;
  variant?: SidebarIllustrationVariant;
  className?: string;
};

type SidebarActionIconProps = {
  kind: SidebarActionIconKind;
  className?: string;
};

const compactPrimaryIllustrations = new Set<SidebarIllustrationKind>([
  "futures",
  "schedule",
  "chat",
  "project",
  "website"
]);

function getSidebarIconClassName(
  kind: SidebarIllustrationKind,
  variant: SidebarIllustrationVariant,
  className?: string
) {
  return [
    "sidebar-illustration",
    `sidebar-illustration-${kind}`,
    `sidebar-illustration-${variant}`,
    kind === "futures" ? "sidebar-illustration-kanban" : "",
    kind === "schedule" ? "sidebar-illustration-automation" : "",
    className ?? ""
  ]
    .filter(Boolean)
    .join(" ");
}

function createSidebarIconProps(
  kind: SidebarIllustrationKind,
  variant: SidebarIllustrationVariant,
  className?: string
): SVGProps<SVGSVGElement> {
  const usesCompactPrimaryGeometry =
    variant === "compact" && compactPrimaryIllustrations.has(kind);
  const usesRailGeometry = variant === "rail";
  return {
    className: getSidebarIconClassName(kind, variant, className),
    viewBox: usesRailGeometry
      ? "0 0 28 28"
      : usesCompactPrimaryGeometry
        ? "0 0 16 16"
        : "0 0 24 24",
    fill: usesRailGeometry ? "currentColor" : "none",
    stroke: usesRailGeometry ? "none" : "currentColor",
    strokeWidth: usesCompactPrimaryGeometry ? 1.4 : 2,
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
          <defs>
            <mask id="double-check-mask">
              <rect x="0" y="0" width="24" height="24" fill="white" />
              <path d="M 7.5 11 L 13.5 20 L 22.5 5" stroke="black" strokeWidth={4.5} strokeLinecap="round" strokeLinejoin="round" fill="none" />
            </mask>
          </defs>
          <path d="M 2 11 L 8 20 L 17 5" mask="url(#double-check-mask)" />
          <path d="M 7.5 11 L 13.5 20 L 22.5 5" />
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

function RailSidebarIllustration({
  kind,
  className
}: Omit<SidebarIllustrationProps, "variant">) {
  const iconProps = createSidebarIconProps(kind, "rail", className);

  switch (kind) {
    case "futures":
      return (
        <svg {...iconProps}>
          <rect
            className="sidebar-illustration-kanban-lane sidebar-illustration-kanban-lane-blue"
            x="4"
            y="5"
            width="5"
            height="18"
            rx="2.5"
          />
          <rect
            className="sidebar-illustration-kanban-lane sidebar-illustration-kanban-lane-green"
            x="11.5"
            y="7"
            width="5"
            height="14"
            rx="2.5"
          />
          <rect
            className="sidebar-illustration-kanban-lane sidebar-illustration-kanban-lane-amber"
            x="19"
            y="9"
            width="5"
            height="10"
            rx="2.5"
          />
        </svg>
      );
    case "schedule":
      return (
        <svg {...iconProps}>
          <path
            fillRule="evenodd"
            d="M14 3a11 11 0 1 1 0 22 11 11 0 0 1 0-22Zm-1.15 4.5v6.84l4.6 2.65 1.15-1.98L15 12.96V7.5h-2.15Z"
          />
        </svg>
      );
    case "chat":
      return (
        <svg {...iconProps}>
          <path
            fillRule="evenodd"
            d="M4 6.25A4.25 4.25 0 0 1 8.25 2h11.5A4.25 4.25 0 0 1 24 6.25v8.5A4.25 4.25 0 0 1 19.75 19H12l-5.5 4v-4.47A4.25 4.25 0 0 1 4 14.75v-8.5ZM9.5 10.6a1.4 1.4 0 1 0 0 2.8 1.4 1.4 0 0 0 0-2.8Zm4.5 0a1.4 1.4 0 1 0 0 2.8 1.4 1.4 0 0 0 0-2.8Zm4.5 0a1.4 1.4 0 1 0 0 2.8 1.4 1.4 0 0 0 0-2.8Z"
          />
        </svg>
      );
    case "project":
      return (
        <svg {...iconProps}>
          <path
            fillRule="evenodd"
            d="M4 6.5A3.5 3.5 0 0 1 7.5 3h4.6l2.75 2.75h7.65A3.5 3.5 0 0 1 26 9.25v11.25A3.5 3.5 0 0 1 22.5 24h-15A3.5 3.5 0 0 1 4 20.5v-14Zm2.25 7.25v2.25h17.5v-2.25H6.25Z"
          />
        </svg>
      );
    case "website":
      return (
        <svg {...iconProps}>
          <path
            fillRule="evenodd"
            d="M14 2.5a11.5 11.5 0 1 1 0 23 11.5 11.5 0 0 1 0-23ZM4.3 13h19.4v2H4.3v-2Zm6.1-9.05c-1.1 2.8-1.75 6.25-1.75 10.05s.65 7.25 1.75 10.05h1.75c-.85-2.8-1.35-6.25-1.35-10.05s.5-7.25 1.35-10.05H10.4Zm5.2 0c.85 2.8 1.35 6.25 1.35 10.05s-.5 7.25-1.35 10.05h1.75c1.1-2.8 1.75-6.25 1.75-10.05s-.65-7.25-1.75-10.05H15.6Z"
          />
        </svg>
      );
    default:
      return <SidebarIllustration kind={kind} className={className} />;
  }
}

export function SidebarIllustration({
  kind,
  variant = "compact",
  className
}: SidebarIllustrationProps) {
  if (variant === "rail") {
    return <RailSidebarIllustration kind={kind} className={className} />;
  }

  const iconProps = createSidebarIconProps(kind, variant, className);

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
    case "chat":
      return (
        <svg {...iconProps}>
          <path d="M13.35 7.15a5.15 5.15 0 0 1-5.15 5.15H5.9l-3.25 2.35v-4.03A5.15 5.15 0 0 1 7.8 2h.4a5.15 5.15 0 0 1 5.15 5.15Z" />
          <circle cx="6.35" cy="7.15" r="0.5" fill="currentColor" stroke="none" />
          <circle cx="8" cy="7.15" r="0.5" fill="currentColor" stroke="none" />
          <circle cx="9.65" cy="7.15" r="0.5" fill="currentColor" stroke="none" />
        </svg>
      );
    case "project":
      return (
        <svg {...iconProps}>
          <path d="M2 5.2A2.2 2.2 0 0 1 4.2 3h2.7l1.65 1.65h3.25A2.2 2.2 0 0 1 14 6.85v5.95A2.2 2.2 0 0 1 11.8 15H4.2A2.2 2.2 0 0 1 2 12.8V5.2Z" />
          <path d="M2 7.35h12" />
        </svg>
      );
    case "login":
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
            x="2"
            y="2"
            width="12"
            height="12"
            rx="2.8"
          />
          <rect
            className="sidebar-illustration-kanban-lane sidebar-illustration-kanban-lane-blue"
            x="4.6"
            y="4.8"
            width="1.55"
            height="6.4"
            rx="0.75"
          />
          <rect
            className="sidebar-illustration-kanban-lane sidebar-illustration-kanban-lane-green"
            x="7.2"
            y="4.8"
            width="1.55"
            height="4.7"
            rx="0.75"
          />
          <rect
            className="sidebar-illustration-kanban-lane sidebar-illustration-kanban-lane-amber"
            x="9.8"
            y="4.8"
            width="1.55"
            height="3.1"
            rx="0.75"
          />
        </svg>
      );
    case "schedule":
      return (
        <svg {...iconProps}>
          <circle className="sidebar-illustration-automation-ring" cx="8" cy="8" r="5.8" />
          <path className="sidebar-illustration-automation-hand" d="M8 4.8v3.6l2.55 1.45" />
        </svg>
      );
    case "website":
      return (
        <svg {...iconProps}>
          <circle cx="8" cy="8" r="5.8" />
          <path d="M2.2 8h11.6" />
          <path d="M8 2.2c1.55 1.55 2.45 3.6 2.45 5.8S9.55 12.25 8 13.8M8 2.2C6.45 3.75 5.55 5.8 5.55 8S6.45 12.25 8 13.8" />
        </svg>
      );
  }
}
