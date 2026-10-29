import type { MarketItem } from "../../../shared/contracts";
import type { MarketShareContext } from "../../../shared/market-share";

/** Local records and a newer catalog entry cannot stand in for a frozen version. */
export function sharedMarketItem(items: readonly MarketItem[], context: MarketShareContext): MarketItem | null {
  const item = items.find(item => item.type === context.resourceType && item.id === context.itemId &&
    item.version === context.resourceVersion && item.source === "cloud" && item.marketplaceAvailable === true);
  return item ? { ...item, ...context.display } : null;
}
