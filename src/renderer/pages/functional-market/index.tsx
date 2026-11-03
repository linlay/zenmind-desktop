import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { DEFAULT_MARKET_TAB, parseMarketTab, marketTabForItemType, type MarketTab, type MarketViewProps } from "./marketPageModel";
import { getMarketView } from "./marketViewRegistry";
import type { MarketLinkDetail } from "../../../shared/contracts";
import type { MarketShareTarget } from "../../../shared/market-share";
import { MarketLinkDetailDialog } from "./MarketSharedDetailDialog";
import { useMarketShareReceiver } from "./useMarketShareReceiver";

export function FunctionalMarketPage({ onShareItem, onRequestAgentChatNavigate }: Pick<MarketViewProps, "onShareItem" | "onRequestAgentChatNavigate">) {
  const [searchParams, setSearchParams] = useSearchParams();
  const linkTarget = searchParams.get("linkTarget") ?? "";
  const [linked, setLinked] = useState<{ id: string; detail: MarketLinkDetail & { install: boolean } } | null>(null);
  const closeLinkedDetail = useCallback(() => {
    setLinked(null);
    setSearchParams(params => {
      const next = new URLSearchParams(params);
      next.delete("linkTarget");
      return next;
    }, { replace: true });
  }, [setSearchParams]);
  useEffect(() => {
    if (!linkTarget) return;
    let current = true;
    void window.electronAPI.market.linkDetail(linkTarget).then(detail => {
      if (!current) return;
      if (detail) setLinked({ id: linkTarget, detail });
      else closeLinkedDetail();
    }).catch(() => { if (current) closeLinkedDetail(); });
    return () => { current = false; };
  }, [closeLinkedDetail, linkTarget]);
  const [activeTab, setActiveTab] = useState<MarketTab>(parseMarketTab(searchParams.get("tab")));
  const [shareTarget, setShareTarget] = useState<MarketShareTarget | null>(null);
  const receive = useCallback((target: MarketShareTarget) => {
    setShareTarget(target);
    setActiveTab(marketTabForItemType(target.context.resourceType) ?? DEFAULT_MARKET_TAB);
  }, []);
  useMarketShareReceiver(searchParams.get("shareActivation") || "", receive);
  if (linkTarget) {
    return linked?.id === linkTarget
      ? <MarketLinkDetailDialog key={linked.id} linkId={linked.id} item={linked.detail} onClose={closeLinkedDetail} />
      : null;
  }
  const ActiveMarket = getMarketView(activeTab);
  return <ActiveMarket activeTab={activeTab} initialItemId={searchParams.get("itemId")?.trim() ?? ""}
    shareTarget={shareTarget} onDismissSharedItem={() => setShareTarget(null)} onShareItem={onShareItem} onTabChange={setActiveTab} onRequestAgentChatNavigate={onRequestAgentChatNavigate} />;
}
