import { useState } from "react";
import { DEFAULT_MARKET_TAB, type MarketTab } from "./marketPageModel";
import { getMarketView } from "./marketViewRegistry";

export function FunctionalMarketPage() {
  const [activeTab, setActiveTab] = useState<MarketTab>(DEFAULT_MARKET_TAB);
  const ActiveMarket = getMarketView(activeTab);

  return <ActiveMarket activeTab={activeTab} onTabChange={setActiveTab} />;
}
