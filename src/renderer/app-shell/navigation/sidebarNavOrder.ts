export type SidebarNavOrderItemKey =
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
  { key: "group:assistants", label: "智能助手" },
  { key: "group:websites", label: "内嵌网站" },
  { key: "market", label: "功能市场" }
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
  serviceItems,
  experimentalItems
}: SidebarNavOrderInput): SidebarNavOrderItem[] {
  const staticItems = new Map(STATIC_SIDEBAR_NAV_ORDER_ITEMS.map((item) => [item.key, item]));
  return [
    staticItems.get("group:assistants")!,
    staticItems.get("group:websites")!,
    ...serviceItems,
    ...experimentalItems,
    staticItems.get("market")!
  ];
}

export function normalizeSidebarNavOrder(
  candidate: unknown,
  availableItems: SidebarNavOrderItem[]
): SidebarNavOrderItemKey[] {
  const availableKeys = new Set(availableItems.map((item) => item.key));
  const normalized: SidebarNavOrderItemKey[] = [];
  if (Array.isArray(candidate)) {
    for (const value of candidate) {
      if (typeof value !== "string" || !availableKeys.has(value as SidebarNavOrderItemKey)) {
        continue;
      }
      const key = value as SidebarNavOrderItemKey;
      if (!normalized.includes(key)) {
        normalized.push(key);
      }
    }
  }

  for (const item of availableItems) {
    if (!normalized.includes(item.key)) {
      normalized.push(item.key);
    }
  }

  return normalized;
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
