import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { parseMarketTab, type MarketTab, type MarketViewProps } from "./marketPageModel";
import { getMarketView } from "./marketViewRegistry";

export function FunctionalMarketPage({ onRequestAgentChatNavigate }: Pick<MarketViewProps, "onRequestAgentChatNavigate">) {
  const [searchParams] = useSearchParams();
  const [activeTab, setActiveTab] = useState<MarketTab>(parseMarketTab(searchParams.get("tab")));
  const ActiveMarket = getMarketView(activeTab);

  return <ActiveMarket activeTab={activeTab} initialItemId={searchParams.get("itemId")?.trim() ?? ""}
    onTabChange={setActiveTab} onRequestAgentChatNavigate={onRequestAgentChatNavigate} />;
}
