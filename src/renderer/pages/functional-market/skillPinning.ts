import type { MarketItem } from "@shared/contracts";

export function marketSkillPinKeys(items: MarketItem[], pinnedItemIds: string[]): string[] {
  const ids = new Set(items.filter((item) => item.type === "skill").map((item) => item.id));
  return [...new Set(pinnedItemIds.filter((id) => ids.has(id)))];
}

export function sortPinnedSkills(items: MarketItem[], pins: string[]): MarketItem[] {
  const rank = new Map(pins.map((id, index) => [id, index]));
  return [...items].sort((a, b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER));
}

export function pinnedMarketItems(items: MarketItem[], order: string[]): string[] {
  const rank = new Map(order.map((key, index) => [key.toLowerCase(), index]));
  const ranked = items.filter((item) => item.type === "skill").flatMap((item) => {
    const position = rank.get(item.id.toLowerCase());
    return position === undefined ? [] : [{ id: item.id, rank: position }];
  });
  return ranked.sort((a, b) => a.rank - b.rank).map((entry) => entry.id);
}
