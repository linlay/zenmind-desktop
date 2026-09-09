import type { MarketItem } from "@shared/contracts";

export function expandPinnedSkillKeys(items: MarketItem[], pinnedItemIds: string[]): string[] {
  const byId = new Map(items.filter((item) => item.type === "skill").map((item) => [item.id, item]));
  return [...new Set(pinnedItemIds.flatMap((id) => {
    const item = byId.get(id);
    if (!item) return [];
    return item.skill?.kind === "package" ? (item.skill.includedSkills ?? []).map((skill) => skill.id) : [item.id];
  }))];
}

export function sortPinnedSkills(items: MarketItem[], pins: string[]): MarketItem[] {
  const rank = new Map(pins.map((id, index) => [id, index]));
  return [...items].sort((a, b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER));
}

export function pinnedMarketItems(items: MarketItem[], order: string[]): string[] {
  const rank = new Map(order.map((key, index) => [key.toLowerCase(), index]));
  const ranked = items.filter((item) => item.type === "skill").flatMap((item) => {
    const keys = item.skill?.kind === "package" ? (item.skill.includedSkills ?? []).map((child) => child.id.toLowerCase()) : [item.id.toLowerCase()];
    if (!keys.length || keys.some((key) => !rank.has(key))) return [];
    return [{ id: item.id, rank: Math.min(...keys.map((key) => rank.get(key)!)) }];
  });
  return ranked.sort((a, b) => a.rank - b.rank).map((entry) => entry.id);
}
