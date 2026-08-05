import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { DEFAULT_MARKET_TAB, type MarketTab } from "./marketPageModel";
import { getMarketView } from "./marketViewRegistry";

export function FunctionalMarketPage() {
  const [searchParams] = useSearchParams();
  const [activeTab, setActiveTab] = useState<MarketTab>(DEFAULT_MARKET_TAB);
  const ActiveMarket = getMarketView(activeTab);

  return <ActiveMarket activeTab={activeTab} initialItemId={searchParams.get("itemId")?.trim() ?? ""} onTabChange={setActiveTab} />;
}
