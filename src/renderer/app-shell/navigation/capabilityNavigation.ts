import type { TranslationKey } from "../../../shared/i18n";
import type { SidebarIllustrationKind } from "../../components/BrandMark";

export type SidebarMode = "primary" | "capabilities" | "settings";

export type CapabilityNavigationItemId =
  | "agents"
  | "skills"
  | "mcp-servers"
  | "registries"
  | "archives"
  | "help";

export type CapabilityNavigationItem = {
  id: CapabilityNavigationItemId;
  to: string;
  labelKey: TranslationKey;
  icon: SidebarIllustrationKind;
  detailPathPrefix?: string;
};

export const CAPABILITY_NAVIGATION_ITEMS: readonly CapabilityNavigationItem[] = [
  {
    id: "agents",
    to: "/agents",
    labelKey: "nav.agents",
    icon: "agent",
    detailPathPrefix: "/agents/",
  },
  {
    id: "skills",
    to: "/skills",
    labelKey: "nav.skills",
    icon: "skill",
    detailPathPrefix: "/skills/",
  },
  {
    id: "mcp-servers",
    to: "/mcp-servers",
    labelKey: "nav.mcpConnectors",
    icon: "connector",
  },
  {
    id: "registries",
    to: "/registries",
    labelKey: "nav.registries",
    icon: "service",
  },
  {
    id: "archives",
    to: "/archives",
    labelKey: "nav.archives",
    icon: "archive",
  },
  {
    id: "help",
    to: "/help",
    labelKey: "nav.help",
    icon: "help",
  },
] as const;

function getRoutePathname(route: string) {
  return route.split(/[?#]/u)[0] || "/";
}

export function getCapabilityNavigationItem(
  route: string,
): CapabilityNavigationItem | null {
  const pathname = getRoutePathname(route);
  return (
    CAPABILITY_NAVIGATION_ITEMS.find(
      (item) =>
        pathname === item.to ||
        (item.detailPathPrefix
          ? pathname.startsWith(item.detailPathPrefix)
          : false),
    ) ?? null
  );
}

export function isCapabilityNavigationRoute(route: string) {
  return getCapabilityNavigationItem(route) !== null;
}

export function resolveSidebarMode(route: string): SidebarMode {
  const pathname = getRoutePathname(route);
  if (pathname === "/settings" || pathname.startsWith("/settings/")) {
    return "settings";
  }
  return isCapabilityNavigationRoute(pathname) ? "capabilities" : "primary";
}
