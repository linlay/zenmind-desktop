import { useCallback, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { DEFAULT_MARKET_TAB, marketTabForItemType, type MarketTab } from "./marketPageModel";
import { getMarketView } from "./marketViewRegistry";
import type { MarketItem } from "../../../shared/contracts";
import type { MarketShareTarget } from "../../../shared/market-share";
import { useMarketShareReceiver } from "./useMarketShareReceiver";

export function FunctionalMarketPage({ onShareItem }: { onShareItem?: (item: MarketItem) => void }) {
  const [searchParams] = useSearchParams();
  const [activeTab, setActiveTab] = useState<MarketTab>(DEFAULT_MARKET_TAB);
  const [shareTarget, setShareTarget] = useState<MarketShareTarget | null>(null);
  const receive = useCallback((target: MarketShareTarget) => {
    setShareTarget(target);
    setActiveTab(marketTabForItemType(target.context.resourceType) ?? DEFAULT_MARKET_TAB);
  }, []);
  useMarketShareReceiver(searchParams.get("shareActivation") || "", receive);
  const ActiveMarket = getMarketView(activeTab);

  return <ActiveMarket activeTab={activeTab} initialItemId={searchParams.get("itemId")?.trim() ?? ""}
    shareTarget={shareTarget} onDismissSharedItem={() => setShareTarget(null)} onShareItem={onShareItem} onTabChange={setActiveTab} />;
}
