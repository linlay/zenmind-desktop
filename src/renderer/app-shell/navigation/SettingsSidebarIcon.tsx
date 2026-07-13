import type { SVGProps } from "react";
import type { SettingsSectionId } from "../../../shared/settings-sections";

export type SettingsSidebarIconKind = SettingsSectionId | "back" | "search";

type SettingsSidebarIconProps = {
  kind: SettingsSidebarIconKind;
  className?: string;
};

function createIconProps(kind: SettingsSidebarIconKind, className?: string): SVGProps<SVGSVGElement> {
  return {
    className: ["settings-sidebar-icon", `settings-sidebar-icon-${kind}`, className ?? ""]
      .filter(Boolean)
      .join(" "),
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.75,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": true,
    focusable: "false"
  };
}

export function SettingsSidebarIcon({ kind, className }: SettingsSidebarIconProps) {
  const iconProps = createIconProps(kind, className);

  switch (kind) {
    case "back":
      return (
        <svg {...iconProps}>
          <polyline points="15 18 9 12 15 6" />
        </svg>
      );
    case "search":
      return (
        <svg {...iconProps}>
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
      );
    case "appearance":
      return (
        <svg {...iconProps}>
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
        </svg>
      );
    case "usage":
      return (
        <svg {...iconProps}>
          <path d="M 4.9 19.1 A 10 10 0 1 1 19.1 19.1" />
          <path d="M 12 12 L 17 7" />
          <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
          <path d="M 12 2 V 5" />
          <path d="M 4.9 4.9 L 7.1 7.1" />
          <path d="M 19.1 4.9 L 16.9 7.1" />
        </svg>
      );
    case "assistant":
      return (
        <svg {...iconProps}>
          <path d="M12 5V2" />
          <circle cx="12" cy="2" r="1" fill="currentColor" stroke="none" />
          <rect x="6" y="5" width="12" height="7" rx="2" />
          <circle cx="9.5" cy="8.5" r="1" fill="currentColor" stroke="none" />
          <circle cx="14.5" cy="8.5" r="1" fill="currentColor" stroke="none" />
          <path d="M10 12v2h4v-2" />
          <rect x="4" y="14" width="16" height="7" rx="2" />
          <line x1="8" y1="17.5" x2="16" y2="17.5" />
        </svg>
      );
    case "navigation":
      return (
        <svg {...iconProps}>
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <path d="M9 3v18M13 8h4M13 12h4M13 16h2" />
        </svg>
      );
    case "control":
      return (
        <svg {...iconProps}>
          <line x1="6" y1="3" x2="6" y2="21" />
          <line x1="12" y1="3" x2="12" y2="21" />
          <line x1="18" y1="3" x2="18" y2="21" />
          <circle cx="6" cy="14" r="2" fill="white" />
          <circle cx="12" cy="8" r="2" fill="white" />
          <circle cx="18" cy="16" r="2" fill="white" />
        </svg>
      );
    case "kanban":
      return (
        <svg {...iconProps}>
          <rect x="3" y="3" width="18" height="18" rx="3" />
          <path d="M8 7v6M12 7v10M16 7v4" />
        </svg>
      );
    case "market":
      return (
        <svg {...iconProps}>
          <rect x="3" y="3" width="7" height="7" rx="1.5" />
          <rect x="14" y="3" width="7" height="7" rx="1.5" />
          <rect x="3" y="14" width="7" height="7" rx="1.5" />
          <path d="M17 14v6M14 17h6" />
        </svg>
      );
    case "tunnelHub":
      return (
        <svg {...iconProps}>
          <circle cx="12" cy="12" r="9" />
          <circle cx="12" cy="12" r="5" />
          <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
          <line x1="5.6" y1="5.6" x2="8.5" y2="8.5" />
          <line x1="18.4" y1="5.6" x2="15.5" y2="8.5" />
          <line x1="5.6" y1="18.4" x2="8.5" y2="15.5" />
          <line x1="18.4" y1="18.4" x2="15.5" y2="15.5" />
        </svg>
      );
    case "plugins":
      return (
        <svg {...iconProps}>
          <rect x="3" y="14" width="7" height="7" rx="1.5" />
          <rect x="3" y="3" width="7" height="7" rx="1.5" />
          <rect x="14" y="14" width="7" height="7" rx="1.5" />
          <rect x="14" y="3" width="7" height="7" rx="1.5" transform="rotate(45 17.5 6.5)" />
        </svg>
      );
    case "websites":
      return (
        <svg {...iconProps}>
          <circle cx="12" cy="12" r="10" />
          <path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
        </svg>
      );
    case "webapps":
      return (
        <svg {...iconProps}>
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <path d="M3 9h18M9 21V9" />
          <path d="M14 13h3M14 17h3" />
        </svg>
      );
    case "about":
      return (
        <svg {...iconProps}>
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="16" x2="12" y2="12" />
          <line x1="12" y1="8" x2="12.01" y2="8" />
        </svg>
      );
    case "debug":
    case "general":
    default:
      return (
        <svg {...iconProps}>
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      );
  }
}
