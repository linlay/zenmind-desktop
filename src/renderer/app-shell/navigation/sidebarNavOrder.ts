export type SidebarNavOrderItemKey =
  | "kanban"
  | "group:assistants"
  | "group:webs"
  | "assistant"
  | "agents"
  | "schedules"
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
  kanbanEnabled?: boolean;
  serviceItems: SidebarNavOrderItem[];
  experimentalItems: SidebarNavOrderItem[];
  webItems: SidebarNavOrderItem[];
};

export const STATIC_SIDEBAR_NAV_ORDER_ITEMS: SidebarNavOrderItem[] = [
  { key: "kanban", label: "nav.taskBoard" },
  { key: "schedules", label: "nav.schedules" },
  { key: "group:assistants", label: "nav.assistants" },
  { key: "group:webs", label: "nav.websites" },
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
  kanbanEnabled = true,
  serviceItems: _serviceItems,
  experimentalItems: _experimentalItems
}: SidebarNavOrderInput): SidebarNavOrderItem[] {
  const staticItems = new Map(STATIC_SIDEBAR_NAV_ORDER_ITEMS.map((item) => [item.key, item]));
  return [
    ...(kanbanEnabled ? [staticItems.get("kanban")!] : []),
    staticItems.get("schedules")!,
    staticItems.get("group:assistants")!,
    staticItems.get("group:webs")!
  ];
}

export function normalizeSidebarNavOrder(
  candidate: unknown,
  availableItems: SidebarNavOrderItem[]
): SidebarNavOrderItemKey[] {
  const availableKeys = new Set(availableItems.map((item) => item.key));
  const normalizedCandidate = Array.isArray(candidate)
    ? candidate.filter((key): key is SidebarNavOrderItemKey =>
        typeof key === "string" && availableKeys.has(key as SidebarNavOrderItemKey)
      )
    : [];
  const orderedKeys = normalizedCandidate.length > 0 ? normalizedCandidate : [];
  for (const item of availableItems) {
    if (!orderedKeys.includes(item.key)) {
      orderedKeys.push(item.key);
    }
  }
  if (availableKeys.has("kanban")) {
    return ["kanban", ...orderedKeys.filter((key) => key !== "kanban")];
  }
  return orderedKeys;
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
