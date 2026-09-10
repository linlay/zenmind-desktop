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
  | "skill"
  | "chat"
  | "project"
  | "login"
  | "logout"
  | "archive"
  | "connector"
  | "market"
  | "help"
  | "settings"
  | "service"
  | "futures"
  | "schedule"
  | "website";

/**
 * Compact geometry is tuned for 16px labels; rail geometry uses a consistent
 * 24px outline grid for collapsed navigation, matching the action icons.
 */
export type SidebarIllustrationVariant = "compact" | "rail";

export type SidebarActionIconKind =
  | "pin"
  | "sidebar_left"
  | "sidebar_right"
  | "back"
  | "forward"
  | "sort"
  | "expand_all"
  | "collapse_all"
  | "refresh"
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
      ? "0 0 24 24"
      : usesCompactPrimaryGeometry
        ? "0 0 16 16"
        : "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: usesRailGeometry ? 1.8 : usesCompactPrimaryGeometry ? 1.4 : 2,
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
          <path d="M20 12H4" />
          <path d="m10 6-6 6 6 6" />
        </svg>
      );
    case "forward":
      return (
        <svg {...iconProps}>
          <path d="M4 12h16" />
          <path d="m14 6 6 6-6 6" />
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
    case "expand_all":
      return (
        <svg {...iconProps}>
          <path d="m6 9 6-6 6 6" />
          <path d="m6 15 6 6 6-6" />
          <path d="M3 12h18" />
        </svg>
      );
    case "collapse_all":
      return (
        <svg {...iconProps}>
          <path d="m6 3 6 6 6-6" />
          <path d="m6 21 6-6 6 6" />
          <path d="M3 12h18" />
        </svg>
      );
    case "refresh":
      return (
        <svg {...iconProps}>
          <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
          <path d="M21 3v5h-5" />
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
          <path d="M10 4H6a3 3 0 0 0-3 3v11a3 3 0 0 0 3 3h11a3 3 0 0 0 3-3v-4" />
          <path d="m15 5 3 3M9 15l1-5 7-7a2.12 2.12 0 0 1 3 3l-7 7-4 2Z" />
        </svg>
      );
    case "pin":
      return (
        <svg {...iconProps}>
          <path d="m14 3 7 7-4 1-3 5-6-6 5-3 1-4Z" />
          <path d="m11 13-7 7" />
        </svg>
      );
    case "more_actions":
      return (
        <svg {...iconProps} viewBox="0 0 16 16" stroke="none">
          <path
            d="M3.33362 6.80811C3.99161 6.80828 4.52502 7.34246 4.52502 8.00049C4.52485 8.65837 3.9915 9.19172 3.33362 9.19189C2.67559 9.19189 2.14141 8.65848 2.14124 8.00049C2.14124 7.34235 2.67548 6.80811 3.33362 6.80811Z"
            fill="currentColor"
          />
          <path
            d="M8.00061 6.80811C8.65849 6.80841 9.19202 7.34254 9.19202 8.00049C9.19184 8.65829 8.65838 9.19159 8.00061 9.19189C7.34258 9.19189 6.8084 8.65848 6.80823 8.00049C6.80823 7.34235 7.34247 6.80811 8.00061 6.80811Z"
            fill="currentColor"
          />
          <path
            d="M12.6666 6.80811C13.3246 6.80828 13.858 7.34246 13.858 8.00049C13.8579 8.65837 13.3245 9.19172 12.6666 9.19189C12.0088 9.1917 11.4744 8.65836 11.4742 8.00049C11.4742 7.34247 12.0087 6.8083 12.6666 6.80811Z"
            fill="currentColor"
          />
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
          <rect x="3" y="3" width="18" height="18" rx="4" />
          <path d="M8 8v8M12 8v5M16 8v3" />
        </svg>
      );
    case "schedule":
      return (
        <svg {...iconProps}>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3.5 2" />
        </svg>
      );
    case "chat":
      return (
        <svg {...iconProps}>
          <path d="M7 4h10a4 4 0 0 1 4 4v7a4 4 0 0 1-4 4H9l-5 3v-5a4 4 0 0 1-1-2V8a4 4 0 0 1 4-4Z" />
          <path d="M8 9h8M8 13h5" />
        </svg>
      );
    case "project":
      return (
        <svg {...iconProps}>
          <path d="M3 7a3 3 0 0 1 3-3h4l2 3h6a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V7Z" />
          <path d="M3 10h18" />
        </svg>
      );
    case "website":
      return (
        <svg {...iconProps}>
          <circle cx="12" cy="12" r="9" />
          <ellipse cx="12" cy="12" rx="4" ry="9" />
          <path d="M3 12h18" />
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
    case "skill":
      return (
        <svg {...iconProps}>
          <path d="m13 2-9.5 11.4a1 1 0 0 0 .8 1.6H12l-1 7 9.5-11.4a1 1 0 0 0-.8-1.6H12z" />
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
    case "connector":
      return (
        <svg {...iconProps}>
          <circle cx="6" cy="12" r="3" />
          <circle cx="18" cy="6" r="3" />
          <circle cx="18" cy="18" r="3" />
          <path d="M9 11l6-4M9 13l6 4" />
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
