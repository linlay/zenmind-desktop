export type SidebarNavOrderItemKey =
  | "kanban"
  | "group:assistants"
  | "group:webs"
  | "assistant"
  | "agents"
  | "schedules"
  | "memory"
  | "market"
  | "help"
  | `service:${string}`
  | `experimental:${string}`
  | `website:${string}`
  | `webapp:${string}`;

export type SidebarNavOrderItem = {
  key: SidebarNavOrderItemKey;
  label: string;
};

type SidebarNavOrderInput = {
  serviceItems: SidebarNavOrderItem[];
  experimentalItems: SidebarNavOrderItem[];
  webItems: SidebarNavOrderItem[];
};

export const STATIC_SIDEBAR_NAV_ORDER_ITEMS: SidebarNavOrderItem[] = [
  { key: "kanban", label: "看板" },
  { key: "schedules", label: "自动化" },
  { key: "group:assistants", label: "助理 / 项目" },
  { key: "group:webs", label: "网站 / 应用" },
];

export function createServiceSidebarNavOrderKey(serviceId: string): SidebarNavOrderItemKey {
  return `service:${serviceId}`;
}

export function createExperimentalSidebarNavOrderKey(itemId: string): SidebarNavOrderItemKey {
  return `experimental:${itemId}`;
}

export function createWebNavOrderKey(entryKey: string): SidebarNavOrderItemKey {
  return entryKey as SidebarNavOrderItemKey;
}

export function createDefaultSidebarNavOrderItems({
  serviceItems: _serviceItems,
  experimentalItems: _experimentalItems
}: SidebarNavOrderInput): SidebarNavOrderItem[] {
  const staticItems = new Map(STATIC_SIDEBAR_NAV_ORDER_ITEMS.map((item) => [item.key, item]));
  return [
    staticItems.get("kanban")!,
    staticItems.get("schedules")!,
    staticItems.get("group:assistants")!,
    staticItems.get("group:webs")!
  ];
}

export function normalizeSidebarNavOrder(
  candidate: unknown,
  availableItems: SidebarNavOrderItem[]
): SidebarNavOrderItemKey[] {
  void candidate;
  return availableItems.map((item) => item.key);
}

export function sortSidebarNavItems<T extends { orderKey: SidebarNavOrderItemKey }>(
  items: T[],
  order: SidebarNavOrderItemKey[]
): T[] {
  const orderIndex = new Map(order.map((key, index) => [key, index]));
  return [...items].sort((left, right) => {
    const leftIndex = orderIndex.get(left.orderKey) ?? Number.MAX_SAFE_INTEGER;
    const rightIndex = orderIndex.get(right.orderKey) ?? Number.MAX_SAFE_INTEGER;
    return leftIndex - rightIndex;
  });
}
