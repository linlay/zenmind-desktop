export type SidebarNavOrderItemKey =
  | "kanban"
  | "group:assistants"
  | "group:websites"
  | "assistant"
  | "agents"
  | "schedules"
  | "memory"
  | "market"
  | "help"
  | `service:${string}`
  | `experimental:${string}`
  | `custom:${string}`;

export type SidebarNavOrderItem = {
  key: SidebarNavOrderItemKey;
  label: string;
};

type SidebarNavOrderInput = {
  serviceItems: SidebarNavOrderItem[];
  experimentalItems: SidebarNavOrderItem[];
  customItems: SidebarNavOrderItem[];
};

export const STATIC_SIDEBAR_NAV_ORDER_ITEMS: SidebarNavOrderItem[] = [
  { key: "kanban", label: "任务看板" },
  { key: "group:assistants", label: "智能助理" },
  { key: "group:websites", label: "内嵌网站" },
];

export function createServiceSidebarNavOrderKey(serviceId: string): SidebarNavOrderItemKey {
  return `service:${serviceId}`;
}

export function createExperimentalSidebarNavOrderKey(itemId: string): SidebarNavOrderItemKey {
  return `experimental:${itemId}`;
}

export function createCustomSidebarNavOrderKey(itemId: string): SidebarNavOrderItemKey {
  return `custom:${itemId}`;
}

export function createDefaultSidebarNavOrderItems({
  serviceItems: _serviceItems,
  experimentalItems: _experimentalItems
}: SidebarNavOrderInput): SidebarNavOrderItem[] {
  const staticItems = new Map(STATIC_SIDEBAR_NAV_ORDER_ITEMS.map((item) => [item.key, item]));
  return [
    staticItems.get("kanban")!,
    staticItems.get("group:assistants")!,
    staticItems.get("group:websites")!
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
